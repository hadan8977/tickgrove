import asyncio, json, os, pathlib
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def main():
    params=StdioServerParameters(command=str(pathlib.Path('server/target/debug/trading-mcp').resolve()),args=[],env={'PATH':os.environ['PATH'],'TRADING_TOKEN':os.environ['TRADING_TOKEN'],'TRADING_URL':os.environ['TRADING_URL']})
    async with stdio_client(params) as (reader,writer):
        async with ClientSession(reader,writer) as session:
            initialized=await session.initialize()
            tools=await session.list_tools();assert any(t.name=='trading_command' for t in tools.tools)
            result=await session.call_tool('trading_command',{'method':'system.capabilities','params':{}});assert not result.isError
            info=json.loads(result.content[0].text);assert info['protocol']=='trading.commands.v1'
            print(json.dumps({'client':'official-python-sdk@1.30.0','protocolVersion':initialized.protocolVersion,'toolsList':True,'toolsCall':True}))
asyncio.run(main())
