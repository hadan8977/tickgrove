//! Local immutable Pine libraries. Workers never download imports at execution time.
use crate::{
    App,
    commands::{hash, required},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};
pub fn imports(source: &str) -> anyhow::Result<Vec<Value>> {
    let mut clean = String::with_capacity(source.len());
    let mut quoted = None;
    let mut block = false;
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        if block {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                block = false;
                clean.push_str("  ");
            } else {
                clean.push(if c == '\n' { '\n' } else { ' ' });
            }
            continue;
        }
        if let Some(q) = quoted {
            clean.push(if c == '\n' { '\n' } else { ' ' });
            if c == '\\' {
                if let Some(n) = chars.next() {
                    clean.push(if n == '\n' { '\n' } else { ' ' });
                }
            } else if c == q {
                quoted = None
            }
            continue;
        }
        if c == '"' || c == '\'' {
            quoted = Some(c);
            clean.push(' ');
        } else if c == '/' && chars.peek() == Some(&'/') {
            chars.next();
            clean.push_str("  ");
            for n in chars.by_ref() {
                if n == '\n' {
                    clean.push('\n');
                    break;
                }
                clean.push(' ');
            }
        } else if c == '/' && chars.peek() == Some(&'*') {
            chars.next();
            block = true;
            clean.push_str("  ");
        } else {
            clean.push(c);
        }
    }
    let mut result = Vec::new();
    for (line, text) in clean.lines().enumerate() {
        let words: Vec<&str> = text.split_whitespace().collect();
        if words.first() != Some(&"import") {
            continue;
        }
        anyhow::ensure!(
            words.len() == 2 || (words.len() == 4 && words[2] == "as"),
            "Invalid library import on line {}",
            line + 1
        );
        let reference = words[1];
        validate_reference(reference)?;
        let alias = if words.len() == 4 {
            words[3]
        } else {
            reference.split('/').nth(1).unwrap()
        };
        anyhow::ensure!(
            identifier(alias),
            "Invalid library alias on line {}",
            line + 1
        );
        result.push(json!({"reference":reference,"alias":alias,"line":line+1}));
    }
    Ok(result)
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
}
fn validate_reference(s: &str) -> anyhow::Result<()> {
    let p: Vec<_> = s.split('/').collect();
    anyhow::ensure!(
        p.len() == 3
            && identifier(p[0])
            && identifier(p[1])
            && p[2].parse::<u32>().is_ok_and(|v| v > 0),
        "Library reference must be publisher/name/positive-version"
    );
    Ok(())
}
pub async fn resolve(app: &App, source: &str) -> anyhow::Result<Value> {
    let roots = imports(source)?;
    let mut pending: Vec<String> = roots
        .iter()
        .map(|v| v["reference"].as_str().unwrap().to_string())
        .collect();
    let mut total = 0usize;
    let mut modules = BTreeMap::new();
    let mut edges: BTreeMap<String, Vec<String>> = BTreeMap::new();
    while let Some(reference) = pending.pop() {
        if modules.contains_key(&reference) {
            continue;
        }
        anyhow::ensure!(modules.len() < 64, "Library dependency count exceeds 64");
        let row = sqlx::query("SELECT * FROM pine_libraries WHERE reference=?")
            .bind(&reference)
            .fetch_optional(&app.db)
            .await?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Missing local Pine library {reference}; install exact version first"
                )
            })?;
        let code: String = row.get("source");
        total += code.len();
        anyhow::ensure!(total <= 4_000_000, "Library dependency sources exceed 4MB");
        let refs: Vec<String> = imports(&code)?
            .iter()
            .map(|v| v["reference"].as_str().unwrap().to_string())
            .collect();
        pending.extend(refs.clone());
        edges.insert(reference.clone(), refs);
        modules.insert(reference.clone(),json!({"reference":reference,"source":code,"hash":row.get::<String,_>("hash"),"license":row.get::<Option<String>,_>("license"),"sourceUrl":row.get::<Option<String>,_>("source_url")}));
    }
    fn visit(
        name: &str,
        edges: &BTreeMap<String, Vec<String>>,
        path: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) -> anyhow::Result<()> {
        if done.contains(name) {
            return Ok(());
        }
        anyhow::ensure!(
            path.len() < 16 && path.insert(name.to_string()),
            "Cyclic or excessive Pine library dependency: {name}"
        );
        for child in &edges[name] {
            visit(child, edges, path, done, order)?;
        }
        path.remove(name);
        done.insert(name.to_string());
        order.push(name.to_string());
        Ok(())
    }
    let mut order = Vec::new();
    let mut done = BTreeSet::new();
    for root in &roots {
        visit(
            root["reference"].as_str().unwrap(),
            &edges,
            &mut BTreeSet::new(),
            &mut done,
            &mut order,
        )?;
    }
    let libraries: Vec<Value> = order
        .into_iter()
        .map(|name| modules.remove(&name).unwrap())
        .collect();
    let pins: Vec<Value> = libraries
        .iter()
        .map(|m| json!({"reference":m["reference"],"hash":m["hash"]}))
        .collect();
    let lock_hash = hash(&json!(pins).to_string());
    Ok(json!({"imports":roots,"libraries":libraries,"lockHash":lock_hash}))
}
pub async fn execute(app: &App, method: &str, p: &Value) -> anyhow::Result<Value> {
    match method {
        "pine.resolve" => resolve(app, required(p, "source")?).await,
        "pine.library.createVersion" => {
            let publisher = required(p, "publisher")?;
            let name = required(p, "name")?;
            let version = p["version"]
                .as_u64()
                .filter(|v| *v > 0 && *v <= u32::MAX as u64)
                .ok_or_else(|| anyhow::anyhow!("Positive library version required"))?;
            let reference = format!("{publisher}/{name}/{version}");
            validate_reference(&reference)?;
            let source = required(p, "source")?;
            anyhow::ensure!(source.len() <= 1000000, "Library exceeds 1MB");
            imports(source)?;
            anyhow::ensure!(
                source
                    .lines()
                    .any(|l| l.trim_start().starts_with("library("))
                    || source
                        .lines()
                        .any(|l| l.trim_start().starts_with("library (")),
                "Pine library() declaration required"
            );
            let digest = hash(source);
            let mut tx = app.db.begin().await?;
            if let Some(old) =
                sqlx::query_scalar::<_, String>("SELECT hash FROM pine_libraries WHERE reference=?")
                    .bind(&reference)
                    .fetch_optional(&mut *tx)
                    .await?
            {
                anyhow::ensure!(
                    old == digest,
                    "library_version_conflict: immutable reference already has different source"
                );
                return Ok(json!({"reference":reference,"hash":digest,"duplicate":true}));
            }
            sqlx::query("INSERT INTO pine_libraries(reference,publisher,name,version,source,hash,license,source_url) VALUES(?,?,?,?,?,?,?,?)").bind(&reference).bind(publisher).bind(name).bind(version as i64).bind(source).bind(&digest).bind(p["license"].as_str()).bind(p["sourceUrl"].as_str()).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(json!({"reference":reference,"hash":digest,"duplicate":false}))
        }
        "pine.library.list" | "pine.library.get" => {
            let rows = if method == "pine.library.get" {
                sqlx::query("SELECT * FROM pine_libraries WHERE reference=?")
                    .bind(required(p, "reference")?)
                    .fetch_all(&app.db)
                    .await?
            } else {
                sqlx::query("SELECT reference,publisher,name,version,hash,license,source_url,created_at,'' AS source FROM pine_libraries ORDER BY created_at DESC,rowid DESC LIMIT 100 OFFSET ?").bind(p["offset"].as_i64().unwrap_or(0).clamp(0,100000)).fetch_all(&app.db).await?
            };
            let values=json!(rows.iter().map(|r|json!({"reference":r.get::<String,_>("reference"),"publisher":r.get::<String,_>("publisher"),"name":r.get::<String,_>("name"),"version":r.get::<i64,_>("version"),"hash":r.get::<String,_>("hash"),"source":r.get::<String,_>("source"),"license":r.get::<Option<String>,_>("license"),"sourceUrl":r.get::<Option<String>,_>("source_url"),"createdAt":r.get::<String,_>("created_at")})).collect::<Vec<_>>());
            if method == "pine.library.get" {
                anyhow::ensure!(!rows.is_empty(), "Library reference not found");
                Ok(values[0].clone())
            } else {
                Ok(values)
            }
        }
        _ => anyhow::bail!("Unknown Pine library command"),
    }
}
