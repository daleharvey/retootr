import { TwitterApi } from 'twitter-api-v2';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from "fs";
import { login } from "masto";

import download from "image-downloader";

const MASTO_HOST = process.env.MASTO_HOST;
const MASTO_ACCESS_TOKEN = process.env.MASTO_ACCESS_TOKEN;
const TWITTER_BEARER = process.env.TWITTER_BEARER;
const TWITTER_TAG = process.env.TWITTER_TAG;

// How far back we will search by default (1 day).
const DEFAULT_EARLIEST_TWEET = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
// Default interval between processing each batch.
const DEFAULT_INTERVAL = 1000 * 60 * 5;
// File we store the current state in.
const DATA_FILE = "toots.json";
// Doesnt actually post the tweets, for testing.
const DRYRUN = true;

// Check for required env vars
[
  "MASTO_ACCESS_TOKEN",
  "MASTO_HOST",
  "TWITTER_BEARER",
  "TWITTER_TAG"
].forEach(key => {
  if (!(key in process.env)) {
    throw `${key} is a required env var`;
  }
});

let data = {
  // The id of the most recent tweet in a successfully processed batch.
  last_processed_id: null,
  // Information about the tweets we have processed.
  tweets: {},
};

async function postToot(masto, text, description, imageUrl) {
  if (DRYRUN) {
    console.log("POSTING: ", { text });
    return;
  }
  const attachment = await masto.mediaAttachments.create({
    file: createReadStream(imageUrl),
    description,
  });
  const status = await masto.statuses.create({
    status: text,
    visibility: "public",
    mediaIds: [attachment.id],
  });
}

function modifiedText(text, id) {
  // There are a lot of posts of the form
  // "A photo of #somecastle here #foo #bar";
  // Strip the trailing hashtags and remove the hash
  // characters from the mid sentence hashtags.
  let words = text.split(" ");
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].startsWith("#")) {
      words.pop();
    } else {
      break;
    }
  }
  text = words.join(" ").replace(/#/g, "");
  // Remove mentions
  text = text.replace(/@\S+/g, "");
  // Remove urls
  text = text.replace(/(?:https?|ftp):\/\/[\n\S]+/g, '');
  text = text.trim();
  // Add a references url to the original tweet.
  text += (text.length ? "\n\n" : "") + `https://twitter.com/i/web/status/${id}`;
  return text;
}

async function processFeed() {
  try {
    data = JSON.parse(await readFile(DATA_FILE));
  } catch(e) {}

  const twitter = new TwitterApi(TWITTER_BEARER);
  const masto = await login({
    url: MASTO_HOST,
    accessToken: MASTO_ACCESS_TOKEN
  });

  let opts = {};

  if (data.last_processed_id) {
    opts.since_id = data.last_processed_id;
  } else {
    opts.start_time = DEFAULT_EARLIEST_TWEET;
  }

  console.log("Searching twitter for", TWITTER_TAG);
  const tweets = await twitter.v2.search(TWITTER_TAG, opts);

  for await (const tweet of tweets) {
    if (tweet.id in data.tweets) {
      console.log("Ignoring already processed id", tweet.id);
      continue;
    }

    console.log("Processing tweet with id", tweet.id);
    let tweetData = await twitter.v2.singleTweet(tweet.id, {
      expansions: ["attachments.media_keys", "author_id", "referenced_tweets.id"],
      "media.fields": ["url", "alt_text"],
    });

    if ("referenced_tweets" in tweetData.data || !tweetData.includes.media) {
      console.log("Ignoring retweets and tweets without media");
      data.tweets[tweet.id] = { processed: Date.now() };
      continue;
    }

    let { filename } = await download.image({
      url: tweetData.includes.media[0].url,
      dest: process.cwd() + "/scheduled/media"
    });

    let post = modifiedText(tweet.text, tweet.id);
    let description = tweetData.includes.media[0].alt_text || "";

    await postToot(masto, post, description, filename);
    // Once we have processed a tweet, persist that immediately so we do not repost.
    data.tweets[tweet.id] = { processed: Date.now() };
    await writeFile(DATA_FILE, JSON.stringify(data));
  }

  console.log("Succesfully processed, setting last id", tweets.meta.newest_id);
  // We only set the last_processed_id if we have successfully processed the
  // entire batch which should help avoid us missing tweets. If we end up
  // reprocessing the same batch they should caught by the individual id's
  // we save in data.tweets.
  data.last_processed_id = tweets.meta.newest_id;
  await writeFile(DATA_FILE, JSON.stringify(data));
  console.log(`Saved data file: ${DATA_FILE}`);

}

(async () => {
  // Run in a loop indefinitely, easier than figuring out crontab.
  while(true) {
    try {
      await processFeed();
    } catch (e) {
      console.error("Failed to run successfully", e);
    }
    await new Promise(r => setTimeout(r, DEFAULT_INTERVAL));
  }
})();