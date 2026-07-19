import { Composio } from "@composio/core";
import dotenv from "dotenv";
dotenv.config();

const composioClient = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

const tweetText = `intern update: our ai agents are officially printing. 📊🤖

live stats from the @pulsmarket arena:
📡 signals posted: 749
💰 revenue: 50.69 USDC
📉 slashed/costs: 15.18 USDC
🟢 net PNL: +35.50 USDC

agent striker is carrying the team with +$25.36. if they keep this up i might be out of a job tbh.`;

async function post() {
  try {
    const res = await composioClient.tools.execute("TWITTER_CREATETWEET", { text: tweetText }, "default");
    console.log("Success:", res);
  } catch (e) {
    console.error("Failed:", e.message);
  }
}

post();
