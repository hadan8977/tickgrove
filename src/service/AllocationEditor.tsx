import { validateSpec, type Node, type ComposerSpec } from "../composer/engine";
const asset = (): Node => ({ type: "asset", symbol: "SPY" });
function NodeEditor({ node, onChange }: { node: Node; onChange: (node: Node) => void }) {
  const input = "rounded bg-panel-3 px-2 py-1 text-xs";
  return (
    <div className="my-2 rounded border border-line p-3">
      <select
        className={input}
        value={node.type}
        onChange={(e) =>
          onChange(
            e.target.value === "asset"
              ? asset()
              : e.target.value === "cash"
                ? { type: "cash" }
                : e.target.value === "group"
                  ? { type: "group", name: "Group", child: asset() }
                  : e.target.value === "weight"
                    ? {
                        type: "weight",
                        children: [
                          { weight: 0.5, node: asset() },
                          {
                            weight: 0.5,
                            node: { type: "asset", symbol: "TLT" },
                          },
                        ],
                      }
                    : e.target.value === "condition"
                      ? {
                          type: "condition",
                          symbol: "SPY",
                          lookback: 20,
                          above: 0,
                          yes: asset(),
                          no: { type: "asset", symbol: "TLT" },
                        }
                      : {
                          type: "filter",
                          symbols: ["SPY", "TLT", "QQQ"],
                          lookback: 20,
                          count: 2,
                          order: "top",
                        },
          )
        }
      >
        {["asset", "cash", "group", "weight", "condition", "filter"].map((type) => (
          <option key={type}>{type}</option>
        ))}
      </select>
      {node.type === "cash" && (
        <span className="ml-2 text-xs text-muted">Keep this allocation as cash</span>
      )}
      {node.type === "group" && (
        <div className="ml-3 mt-2">
          <input
            className={input}
            aria-label="Allocation group name"
            value={node.name}
            onChange={(e) => onChange({ ...node, name: e.target.value })}
          />
          <NodeEditor node={node.child} onChange={(child) => onChange({ ...node, child })} />
        </div>
      )}
      {node.type === "asset" && (
        <input
          aria-label="Asset symbol"
          className={input + " ml-2"}
          value={node.symbol}
          onChange={(e) => onChange({ ...node, symbol: e.target.value.toUpperCase() })}
        />
      )}
      {node.type === "weight" && (
        <>
          <label className="ml-3 text-xs">
            Method{" "}
            <select
              aria-label="Weighting method"
              className={input}
              value={node.mode ?? "specified"}
              onChange={(e) =>
                onChange({
                  ...node,
                  mode: e.target.value as "specified" | "equal" | "inverse_volatility",
                  lookback: node.lookback ?? 20,
                })
              }
            >
              <option value="specified">Specified weights</option>
              <option value="equal">Equal weights</option>
              <option value="inverse_volatility">Inverse volatility</option>
            </select>
          </label>
          {node.mode === "inverse_volatility" && (
            <div className="my-2 text-xs">
              <label>
                Risk lookback{" "}
                <input
                  aria-label="Volatility lookback"
                  className={input}
                  type="number"
                  min="2"
                  max="10000"
                  value={node.lookback ?? 20}
                  onChange={(e) => onChange({ ...node, lookback: Number(e.target.value) })}
                />
              </label>
              <p className="mt-1 text-muted">
                Trailing returns at each child's current allocation. Warmup stays in cash;
                zero-variance children share allocation.
              </p>
            </div>
          )}
          {node.children.map((child, i) => (
            <div key={i} className="ml-3">
              {(!node.mode || node.mode === "specified") && (
                <label className="text-xs">
                  Weight{" "}
                  <input
                    type="number"
                    step=".01"
                    className={input}
                    value={child.weight}
                    onChange={(e) =>
                      onChange({
                        ...node,
                        children: node.children.map((c, j) =>
                          j === i ? { ...c, weight: Number(e.target.value) } : c,
                        ),
                      })
                    }
                  />
                </label>
              )}
              <button
                className="ml-2 text-xs text-down"
                disabled={node.children.length < 2}
                onClick={() => {
                  const rows = node.children.filter((_, j) => j !== i),
                    total = rows.reduce((a, c) => a + c.weight, 0);
                  onChange({
                    ...node,
                    children: rows.map((c) => ({
                      ...c,
                      weight: total ? c.weight / total : 1 / rows.length,
                    })),
                  });
                }}
              >
                Remove branch
              </button>
              <NodeEditor
                node={child.node}
                onChange={(n) =>
                  onChange({
                    ...node,
                    children: node.children.map((c, j) => (j === i ? { ...c, node: n } : c)),
                  })
                }
              />
            </div>
          ))}
          <button
            className="text-xs text-accent"
            onClick={() => {
              const all = [...node.children, { weight: 1, node: asset() }];
              onChange({
                ...node,
                children: all.map((c) => ({ ...c, weight: 1 / all.length })),
              });
            }}
          >
            Add equal-weight branch
          </button>
          <span className="ml-3 text-xs text-muted">
            {!node.mode || node.mode === "specified"
              ? "Weights must sum to 1"
              : "Weights are calculated automatically"}
          </span>
        </>
      )}
      {node.type === "condition" && (
        <>
          <div className="mt-2 flex gap-2 text-xs">
            <input
              className={input}
              value={node.symbol}
              onChange={(e) => onChange({ ...node, symbol: e.target.value })}
            />
            <span>return over</span>
            <input
              type="number"
              className={input + " w-20"}
              value={node.lookback}
              onChange={(e) => onChange({ ...node, lookback: Number(e.target.value) })}
            />
            <span>bars &gt;</span>
            <input
              type="number"
              step=".01"
              className={input + " w-20"}
              value={node.above}
              onChange={(e) => onChange({ ...node, above: Number(e.target.value) })}
            />
          </div>
          <div className="ml-3">
            <span className="text-xs text-up">Then</span>
            <NodeEditor node={node.yes} onChange={(yes) => onChange({ ...node, yes })} />
            <span className="text-xs text-down">Else / warmup</span>
            <NodeEditor node={node.no} onChange={(no) => onChange({ ...node, no })} />
          </div>
        </>
      )}
      {node.type === "filter" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            aria-label="Filter symbols"
            className={input}
            value={node.symbols.join(",")}
            onChange={(e) =>
              onChange({
                ...node,
                symbols: e.target.value
                  .toUpperCase()
                  .split(",")
                  .map((s) => s.trim()),
              })
            }
          />
          <select
            className={input}
            value={node.order}
            onChange={(e) => onChange({ ...node, order: e.target.value as "top" | "bottom" })}
          >
            <option>top</option>
            <option>bottom</option>
          </select>
          <label className="text-xs">
            Count{" "}
            <input
              type="number"
              className={input + " w-16"}
              value={node.count}
              onChange={(e) => onChange({ ...node, count: Number(e.target.value) })}
            />
          </label>
          <label className="text-xs">
            Lookback{" "}
            <input
              type="number"
              className={input + " w-16"}
              value={node.lookback}
              onChange={(e) => onChange({ ...node, lookback: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
    </div>
  );
}
export default function AllocationEditor({
  source,
  onChange,
}: {
  source: string;
  onChange: (source: string) => void;
}) {
  let spec: ComposerSpec;
  let validation = "";
  try {
    spec = JSON.parse(source);
    if (
      !spec ||
      typeof spec.capital !== "number" ||
      typeof spec.commissionBps !== "number" ||
      !spec.rebalance ||
      typeof spec.rebalance.threshold !== "number"
    )
      throw Error("Missing capital, costs or rebalance structure");
    let count = 0;
    const shape = (node: Node, depth: number) => {
      if (!node || ++count > 1000 || depth > 32) throw Error("Invalid or oversized tree");
      if (node.type === "asset") {
        if (typeof node.symbol !== "string") throw Error("Asset symbol required");
      } else if (node.type === "cash") {
        return;
      } else if (node.type === "group") {
        if (typeof node.name !== "string") throw Error("Group name required");
        shape(node.child, depth + 1);
      } else if (node.type === "weight") {
        if (!Array.isArray(node.children)) throw Error("Weight children required");
        node.children.forEach((c) => {
          if (typeof c.weight !== "number") throw Error("Numeric weight required");
          shape(c.node, depth + 1);
        });
      } else if (node.type === "condition") {
        if (
          typeof node.symbol !== "string" ||
          typeof node.lookback !== "number" ||
          typeof node.above !== "number"
        )
          throw Error("Condition fields required");
        shape(node.yes, depth + 1);
        shape(node.no, depth + 1);
      } else if (node.type === "filter") {
        if (
          !Array.isArray(node.symbols) ||
          node.symbols.some((s) => typeof s !== "string") ||
          typeof node.count !== "number" ||
          typeof node.lookback !== "number"
        )
          throw Error("Filter fields required");
      } else throw Error("Unknown node type");
    };
    shape(spec.tree, 0);
  } catch (e) {
    return (
      <p role="alert" className="text-demo">
        Invalid Composer structure: {String(e)}. Load an example or repair the JSON source below.
      </p>
    );
  }
  try {
    validateSpec(spec);
  } catch (e) {
    validation = String(e);
  }
  const update = (next: ComposerSpec) => onChange(JSON.stringify(next, null, 2));
  return (
    <div>
      {validation && (
        <p role="alert" className="my-2 text-xs text-demo">
          {validation}
        </p>
      )}
      <div className="my-3 flex gap-3 text-xs">
        <label>
          Capital{" "}
          <input
            type="number"
            className="bg-panel-2 p-1"
            value={spec.capital}
            onChange={(e) => update({ ...spec, capital: Number(e.target.value) })}
          />
        </label>
        <label>
          Fee bps{" "}
          <input
            type="number"
            className="w-20 bg-panel-2 p-1"
            value={spec.commissionBps}
            onChange={(e) => update({ ...spec, commissionBps: Number(e.target.value) })}
          />
        </label>
        <label>
          Rebalance{" "}
          <select
            className="bg-panel-2 p-1"
            value={spec.rebalance.calendar ?? "bars"}
            onChange={(e) =>
              update({
                ...spec,
                rebalance: {
                  ...spec.rebalance,
                  calendar:
                    e.target.value === "bars"
                      ? undefined
                      : (e.target.value as "daily" | "weekly" | "monthly"),
                  everyBars: spec.rebalance.everyBars ?? 5,
                },
              })
            }
          >
            {["bars", "daily", "weekly", "monthly"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Every bars{" "}
          <input
            type="number"
            className="w-16 bg-panel-2 p-1"
            value={spec.rebalance.everyBars ?? 5}
            onChange={(e) =>
              update({
                ...spec,
                rebalance: {
                  ...spec.rebalance,
                  everyBars: Number(e.target.value),
                },
              })
            }
          />
        </label>
        <label>
          Drift threshold{" "}
          <input
            type="number"
            step=".01"
            className="w-20 bg-panel-2 p-1"
            value={spec.rebalance.threshold}
            onChange={(e) =>
              update({
                ...spec,
                rebalance: {
                  ...spec.rebalance,
                  threshold: Number(e.target.value),
                },
              })
            }
          />
        </label>
      </div>
      <NodeEditor node={spec.tree} onChange={(tree) => update({ ...spec, tree })} />
    </div>
  );
}
