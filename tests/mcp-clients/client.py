import asyncio, json, os, pathlib
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def main():
    env={key:os.environ[key] for key in ['PATH','TICKGROVE_TOKEN','TICKGROVE_TOKEN_FILE','TICKGROVE_URL','TRADING_TOKEN','TRADING_TOKEN_FILE','TRADING_URL'] if key in os.environ}
    params=StdioServerParameters(command=str(pathlib.Path(os.environ.get('TICKGROVE_MCP_BIN','server/target/debug/tickgrove-mcp')).resolve()),args=[],env=env)
    async with stdio_client(params) as (reader,writer):
        async with ClientSession(reader,writer) as session:
            initialized=await session.initialize()
            assert initialized.serverInfo.name=='tickgrove-mcp'
            tools=await session.list_tools()
            for name in ['tickgrove_command','trading_command']:assert any(t.name==name for t in tools.tools)
            result=await session.call_tool('tickgrove_command',{'method':'system.capabilities','params':{}});assert not result.isError
            info=json.loads(result.content[0].text);assert info['protocol']=='trading.commands.v1'
            legacy=await session.call_tool('trading_command',{'method':'system.capabilities','params':{}});assert not legacy.isError;assert json.loads(legacy.content[0].text)==info
            print(json.dumps({'client':'official-python-sdk@1.30.0','protocolVersion':initialized.protocolVersion,'server':'tickgrove-mcp','toolsList':True,'toolsCall':True,'legacyAlias':True}))
asyncio.run(main())
