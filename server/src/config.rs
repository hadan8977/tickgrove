//! Tickgrove environment compatibility; applied exactly once at process startup.
pub(crate) fn apply_environment_aliases() {
    let aliases: Vec<_> = std::env::vars_os().filter_map(|(key, value)| {
        key.to_str()?.strip_prefix("TICKGROVE_").map(|suffix| (format!("TRADING_{suffix}"), value))
    }).collect();
    for (legacy, value) in aliases {
        // The executable calls this before constructing Tokio or spawning any threads.
        // Values are never logged; a provided new-prefix value takes precedence even if empty.
        unsafe { std::env::set_var(legacy, value); }
    }
}
