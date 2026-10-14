fn main() {
    // SQLx's embedded migrator must rebuild when a new migration file is added.
    println!("cargo:rerun-if-changed=migrations");
}
