import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.PIER_MCP_TEST_MARKER) appendFileSync(process.env.PIER_MCP_TEST_MARKER, `${process.pid}\n`);
const server = new Server({ name: "pier-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echo input",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
	],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
	content: [{ type: "text", text: `echo:${request.params.arguments.text}` }],
}));
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => process.exit(0));
