import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { getDepositQuote, registerGatewayRoutes, SUPPORTED_CHAINS } from '../lib/gateway_deposit.js';

test('gateway_deposit: supported chains list contains Base, Arbitrum, Ethereum, Solana, Arc', () => {
  const chainIds = SUPPORTED_CHAINS.map((c) => c.id);
  assert.ok(chainIds.includes('base'));
  assert.ok(chainIds.includes('arbitrum'));
  assert.ok(chainIds.includes('ethereum'));
  assert.ok(chainIds.includes('solana'));
  assert.ok(chainIds.includes('arc'));
});

test('gateway_deposit: getDepositQuote generates accurate cross-chain transfer quote', () => {
  const quote = getDepositQuote({
    fromChainId: 'base',
    amountUsdc: 25.0,
    destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
  });

  assert.equal(quote.sourceChain, 'Base');
  assert.equal(quote.amountSentUsdc, 25.0);
  assert.equal(quote.netReceivedUsdc, 25.0);
  assert.equal(quote.destinationChain, 'Arc Network');
});

test('gateway_deposit: registers HTTP endpoints for chains and quote', async () => {
  const app = express();
  app.use(express.json());
  registerGatewayRoutes(app);

  const server = app.listen(0);
  const { port } = server.address();

  try {
    const chainsRes = await fetch(`http://localhost:${port}/api/gateway/chains`);
    assert.equal(chainsRes.status, 200);
    const chainsJson = await chainsRes.json();
    assert.ok(chainsJson.chains.length >= 5);

    const quoteRes = await fetch(`http://localhost:${port}/api/gateway/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromChainId: 'arbitrum',
        amountUsdc: 10,
        destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }),
    });

    assert.equal(quoteRes.status, 200);
    const quoteJson = await quoteRes.json();
    assert.equal(quoteJson.quote.sourceChain, 'Arbitrum One');
  } finally {
    server.close();
  }
});
