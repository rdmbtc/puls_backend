import { Composio } from '@composio/core';

const COMPOSIO_API_KEY = 'ak_QSvsNM-AW2LFK1L20uuT';

async function test() {
  console.log('Testing Composio Execute Action...');
  try {
    const composio = new Composio({ apiKey: COMPOSIO_API_KEY });
    
    // Instead of executing, let's just get the tools to ensure SDK works
    const toolset = composio; // Composio class is also the toolset basically? No wait, ComposioToolSet is what we need for tools.
    // Let's just try to fetch Twitter tools
    // We don't have ComposioToolSet imported. Let's try executing an action directly.
    const res = await composio.executeAction('TWITTER_SEARCH_RECENT_TWEETS', { query: 'crypto' }, 'default'); // 'default' entity
    console.log('Action response:', res);
  } catch (e) {
    console.error('Composio test failed:', e.message);
  }
}

test();
