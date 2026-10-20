import { YoutubeTranscript } from 'youtube-transcript';

const YOUTUBE_ID_REGEX =
  /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;

export function getYoutubeVideoId(url) {
  const match = (url || '').match(YOUTUBE_ID_REGEX);
  return match ? match[1] : null;
}

export async function getYoutubeTranscript(videoId) {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    return segments.map((segment) => segment.text).join(' ');
  } catch (error) {
    console.error(`Could not fetch transcript for ${videoId}:`, error.message);
    return null;
  }
}
