import { ComposioToolSet } from 'composio-core';

const COMPOSIO_API_KEY = 'ak_QSvsNM-AW2LFK1L20uuT';

async function test() {
  console.log('Testing Composio SDK...');
  try {
    const toolset = new ComposioToolSet({ apiKey: COMPOSIO_API_KEY });
    
    // Check connected accounts
    const accounts = await toolset.client.connectedAccounts.get();
    console.log('Connected accounts:', accounts.map(a => a.appUniqueId));

    // Get tools for specific apps
    const tools = await toolset.getTools({ apps: ["twitter", "reddit", "github"] });
    console.log(`Successfully fetched ${tools.length} tools for Twitter/Reddit/GitHub.`);
    
  } catch (e) {
    console.error('Composio test failed:', e.message);
  }
}

test();
