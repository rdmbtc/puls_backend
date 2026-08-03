const circleKey = process.env.CIRCLE_API_KEY || '';
const wid = 'ed23d029-ed41-5be9-a0d1-041d45a00b4c';
const r = await fetch(`https://api.circle.com/v1/wallets/${wid}`, {
  headers: { Authorization: `Bearer ${circleKey}` },
});
console.log('status:', r.status);
console.log('body:', (await r.text()).slice(0, 2000));
process.exit(0);
