fn main() -> anyhow::Result<()> {
    tickgrove::start(tickgrove::tooling::mcp::run())
}
