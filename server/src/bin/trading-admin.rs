fn main() -> anyhow::Result<()> {
    tickgrove::start(tickgrove::tooling::admin::run())
}
