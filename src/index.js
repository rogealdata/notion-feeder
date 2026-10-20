import getNewFeedItems from './feed';
import {
  addFeedItemToNotion,
  deleteOldUnreadFeedItemsFromNotion,
} from './notion';
import htmlToNotionBlocks, { markdownToNotionBlocks } from './parser';
import summarizeTranscript, { isSummarizerEnabled } from './summarizer';
import { getYoutubeTranscript, getYoutubeVideoId } from './youtube';

async function getVideoSummaryBlocks(item) {
  const videoId = getYoutubeVideoId(item.link);
  if (!videoId || !isSummarizerEnabled()) return [];

  const transcript = await getYoutubeTranscript(videoId);
  if (!transcript) return [];

  const summary = await summarizeTranscript(item.title, transcript);
  if (!summary) return [];

  return markdownToNotionBlocks(`## Summary\n\n${summary}\n\n---`);
}

async function index() {
  const feedItems = await getNewFeedItems();

  for (let i = 0; i < feedItems.length; i++) {
    const item = feedItems[i];
    const notionItem = {
      title: item.title,
      link: item.link,
      content: [
        ...(await getVideoSummaryBlocks(item)),
        ...htmlToNotionBlocks(item.content || ''),
      ],
    };
    await addFeedItemToNotion(notionItem);
  }

  await deleteOldUnreadFeedItemsFromNotion();
}

index();
