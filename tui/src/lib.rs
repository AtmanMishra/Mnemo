//! Shared cockpit internals. `seatui` (the legacy inline REPL) still compiles
//! its own module tree from main.rs; everything the cockpit needs lives here.
pub mod cockpit;
pub mod cockpit_ui;
pub mod md;
pub mod memclient;
pub mod rpc;
pub mod theme;
