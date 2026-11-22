fn main() {
    println!("cargo:rerun-if-changed=assets/petdex.ico");
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/petdex.ico");
        res.set("ProductName", "Petdex");
        res.set("FileDescription", "Petdex Desktop Companion");
        res.set("CompanyName", "Crafter Station");
        res.set("LegalCopyright", "Crafter Station, LLC");
        res.compile().expect("failed to compile Windows resources");
    }
}
