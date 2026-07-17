const COMPOSIO_API_KEY = 'ak_QSvsNM-AW2LFK1L20uuT';

async function test() {
  console.log('Testing Composio REST API...');
  try {
    const res = await fetch('https://backend.composio.dev/api/v1/connectedAccounts', {
      headers: { 'x-api-key': COMPOSIO_API_KEY }
    });
    const data = await res.json();
    console.log('Connected accounts:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Composio test failed:', e.message);
  }
}

test();
