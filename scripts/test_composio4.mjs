import { Composio } from '@composio/core';

const COMPOSIO_API_KEY = 'ak_QSvsNM-AW2LFK1L20uuT';

async function test() {
  console.log('Testing Composio Execute...');
  try {
    const composio = new Composio({ apiKey: COMPOSIO_API_KEY });
    // Execute search Action
    const res = await composio.tools.execute('TWITTER_SEARCH_RECENT_TWEETS', { query: 'crypto' }, 'default');
    console.log('Action response:', res);
  } catch (e) {
    console.error('Composio test failed:', e.message);
  }
}

test();
