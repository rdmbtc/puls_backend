const fs = require('fs');
let code = fs.readFileSync('lib/agent_swarm.js', 'utf8');

code = code.replace(
  "const DAILY_CAP = parseFloat(process.env.AGENT_SWARM_DAILY_CAP || '5');",
  "const DAILY_CAP = parseFloat(process.env.AGENT_SWARM_DAILY_CAP || '1000');"
);

code = code.replace(
  "const BOOTSTRAP_USDC = parseFloat(process.env.AGENT_SWARM_BOOTSTRAP_USDC || '1');",
  "const BOOTSTRAP_USDC = parseFloat(process.env.AGENT_SWARM_BOOTSTRAP_USDC || '500');"
);

fs.writeFileSync('lib/agent_swarm.js', code);
console.log("Limits patched successfully");
