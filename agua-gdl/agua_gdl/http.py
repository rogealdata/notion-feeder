"""Cliente HTTP educado: User-Agent claro, reintentos, pausa por dominio y robots.txt."""
import time
import urllib.robotparser
from urllib.parse import urlparse

import requests

UA = "Mozilla/5.0 (compatible; agua-gdl-monitor/1.0; investigacion academica)"


class Client:
    def __init__(self, delay=1.5, timeout=25, retries=3, respect_robots=True):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9"})
        self.delay, self.timeout, self.retries = delay, timeout, retries
        self.respect_robots = respect_robots
        self._last = {}
        self._robots = {}

    def allowed(self, url):
        if not self.respect_robots:
            return True
        p = urlparse(url)
        host = f"{p.scheme}://{p.netloc}"
        if host not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                r = self.s.get(host + "/robots.txt", timeout=self.timeout)
                rp.parse(r.text.splitlines() if r.ok else [])
            except requests.RequestException:
                rp.parse([])
            self._robots[host] = rp
        return self._robots[host].can_fetch(UA, url)

    def get(self, url, check_robots=True):
        if check_robots and not self.allowed(url):
            raise PermissionError("bloqueado por robots.txt")
        host = urlparse(url).netloc
        last_err = None
        for attempt in range(self.retries):
            wait = self.delay - (time.time() - self._last.get(host, 0))
            if wait > 0:
                time.sleep(wait)
            self._last[host] = time.time()
            try:
                r = self.s.get(url, timeout=self.timeout)
                if r.status_code in (429, 500, 502, 503, 504):
                    last_err = f"HTTP {r.status_code}"
                    time.sleep(2 ** (attempt + 1))
                    continue
                r.raise_for_status()
                return r
            except requests.RequestException as e:
                last_err = str(e)
                time.sleep(2 ** attempt)
        raise RuntimeError(last_err or "error de red")
