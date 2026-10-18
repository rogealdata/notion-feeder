"""Relevancia, postura (a favor / en contra), estrategia y temas de crítica. Todo con reglas, sin LLM."""
import re
from collections import Counter

from .config import compile_patterns
from .textutil import norm, split_sentences

STANCES = ("a_favor", "en_contra", "mixta", "neutral")


def _weighted(groups):
    """{peso: [patrones]} -> [(regex, peso)]"""
    return [(compile_patterns(pats), float(w)) for w, pats in groups.items()]


def _non_overlapping(matches):
    """Conserva los matches más largos sin solaparse."""
    taken, out = [], []
    for m in sorted(matches, key=lambda m: (-(m[1] - m[0]), m[0])):
        if all(m[1] <= t[0] or m[0] >= t[1] for t in taken):
            taken.append(m)
            out.append(m)
    return out


class Analyzer:
    def __init__(self, cfg):
        lex, kw = cfg.lexicon, cfg.keywords
        self.u = lex["umbrales"]
        self.actors = compile_patterns(lex["actores_gobierno"])
        self.neg = set(lex["negadores"])
        self.kinds = {k: _weighted(lex[k]) for k in ("critica", "atribucion", "problema", "favor")}
        self.strategy = compile_patterns(lex["estrategia"])
        self.voices = {k: compile_patterns(v) for k, v in lex["voces"].items()}
        self.water = compile_patterns(kw["agua"])
        self.geo = compile_patterns(kw["geo"])
        self.exclude = compile_patterns(kw["excluir"]) if kw.get("excluir") else None
        self.rel_thr = kw["umbrales_relevancia"]
        self.themes = {k: (v["etiqueta"], compile_patterns(v["patrones"])) for k, v in cfg.themes.items()}
        self.problem_any = compile_patterns(
            [p for pats in lex["problema"].values() for p in pats] + lex["estrategia"])

    # ---------- oraciones ----------
    def _negated(self, s, start):
        # solo cuenta la cláusula actual (después de la última coma, punto y coma o dos puntos)
        clause = re.split(r"[,;:.]", s[:start])[-1]
        return any(w in self.neg for w in clause.split()[-3:])

    def _hits(self, s, kind):
        raw = []
        for rx, w in self.kinds[kind]:
            for m in rx.finditer(s):
                raw.append((m.start(), m.end(), w))
        return [(a, b, w, self._negated(s, a), s[a:b]) for a, b, w in _non_overlapping(raw)]

    def sentence(self, original):
        s = norm(original).replace("sin embargo", "sinembargo")
        actors = [m.group(0) for m in self.actors.finditer(s)]
        has_actor = bool(actors)
        u = self.u
        crit = favor = 0.0
        terms = []

        for a, b, w, neg, txt in self._hits(s, "critica"):
            if neg:
                favor += 0.8 * w
            else:
                crit += w
                terms.append(txt)
        for a, b, w, neg, txt in self._hits(s, "favor"):
            if neg:
                crit += 0.8 * w
                terms.append("no " + txt)
            else:
                favor += w
        for a, b, w, neg, txt in self._hits(s, "problema"):
            if not neg:
                crit += w * (1.0 if has_actor else u["factor_problema_sin_actor"])
                if has_actor:
                    terms.append(txt)
        for a, b, w, neg, txt in self._hits(s, "atribucion"):
            if not neg:
                crit += w * (1.0 if has_actor else 0.4)
                if has_actor:
                    terms.append(txt)

        if has_actor:
            crit *= u["factor_actor"]
            favor *= u["factor_actor"]
        return {
            "text": original.strip(), "norm": s, "crit": crit, "favor": favor, "actors": actors,
            "terms": terms, "strategy": bool(self.strategy.search(s)) and has_actor,
        }

    # ---------- nota completa ----------
    def relevance(self, title, text):
        t, body = norm(title), norm(text)
        full = t + " " + body
        if self.exclude and self.exclude.search(t):
            return False, 0.0
        agua = 3 * len(self.water.findall(t)) + len(self.water.findall(body[:3000]))
        geo = len(self.geo.findall(full))
        prob = len(self.problem_any.findall(full))
        ok = (agua >= self.rel_thr["min_agua"] and geo >= self.rel_thr["min_geo"]
              and prob >= self.rel_thr["min_problema"])
        return ok, float(agua + geo + prob)

    def analyze(self, title, text):
        relevant, rel_score = self.relevance(title, text)
        sents = split_sentences(text)
        scored = [self.sentence(s) for s in sents]
        t = self.sentence(title) if title else None

        crit = favor = strat = 0.0
        if t:
            crit += t["crit"] * self.u["peso_titulo"]
            favor += t["favor"] * self.u["peso_titulo"]
            strat += 1.0 * self.u["peso_titulo"] if t["strategy"] else 0
        for i, s in enumerate(scored):
            w = self.u["peso_entradilla"] if i < 2 else 1.0
            crit += s["crit"] * w
            favor += s["favor"] * w
            strat += 1.0 * w if s["strategy"] else 0

        stance, conf = self.decide(crit, favor)

        # evidencia: las oraciones que más pesan en cada sentido
        def top(key, n=3):
            pool = ([t] if t else []) + scored
            ranked = sorted((s for s in pool if s[key] > 0), key=lambda s: -s[key])[:n]
            return [{"frase": s["text"][:400], "puntos": round(s[key], 1), "terminos": s["terms"][:4]} for s in ranked]

        evidence = {"critica": top("crit"), "favor": top("favor")}
        crit_sents = [s for s in scored if s["crit"] >= 2]
        targets, voices = Counter(), Counter()
        for s in crit_sents:
            for a in set(s["actors"]):
                targets[a] += 1
            for label, rx in self.voices.items():
                if rx.search(s["norm"]):
                    voices[label] += 1
        full_norm = norm((title or "") + " " + (text or ""))
        themes = [{"tema": k, "etiqueta": lab, "menciones": len(rx.findall(full_norm))}
                  for k, (lab, rx) in self.themes.items() if len(rx.findall(full_norm)) >= 2]
        themes.sort(key=lambda x: -x["menciones"])
        # los temas de crítica solo cuentan si hay crítica en la nota
        if stance not in ("en_contra", "mixta"):
            themes = []

        return {
            "relevant": relevant, "rel_score": rel_score, "stance": stance, "confidence": conf,
            "crit_score": round(crit, 1), "favor_score": round(favor, 1), "strategy_score": round(strat, 1),
            "covers_strategy": strat >= self.u["min_estrategia"],
            "themes": themes, "evidence": evidence,
            "targets": dict(targets.most_common(5)), "voices": dict(voices.most_common(5)),
        }

    def decide(self, crit, favor):
        u = self.u
        total = crit + favor
        if total < u["min_senal"]:
            return "neutral", 0.0
        ratio = (crit + 1) / (favor + 1)
        if ratio >= u["razon"]:
            stance = "en_contra"
        elif ratio <= 1 / u["razon"]:
            stance = "a_favor"
        else:
            stance = "mixta"
        conf = round(min(1.0, abs(crit - favor) / (total + 3)) * min(1.0, total / 10), 2)
        return stance, conf
