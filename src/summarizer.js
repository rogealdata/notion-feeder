import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const { ANTHROPIC_API_KEY, SUMMARY_MODEL, SUMMARY_LANGUAGE } = process.env;

// Roughly 100k tokens of transcript is more than enough for a summary
const MAX_TRANSCRIPT_CHARS = 400000;

export function isSummarizerEnabled() {
  return Boolean(ANTHROPIC_API_KEY);
}

export default async function summarizeTranscript(title, transcript) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const language = SUMMARY_LANGUAGE || 'the same language as the video';

  try {
    const message = await client.messages.create({
      model: SUMMARY_MODEL || 'claude-sonnet-5-5',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: `Summarize the YouTube video "${title}" from its transcript below.
Write in ${language}. Use Markdown with a 2-3 sentence overview followed by a bulleted list of the key points. Do not add any preamble.

<transcript>
${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}
</transcript>`,
        },
      ],
    });
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  } catch (error) {
    console.error(error);
    return null;
  }
}
