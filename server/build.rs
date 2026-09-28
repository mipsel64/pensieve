fn main() {
    // include_dir! doesn't tell cargo about the files it embeds.
    println!("cargo:rerun-if-changed=web/dist");
}
