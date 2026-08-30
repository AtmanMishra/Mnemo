//! Shared cockpit internals. `seatui` (the legacy inline REPL) still compiles
//! its own module tree from main.rs; everything the cockpit needs lives here.
pub mod cockpit;
pub mod cockpit_ui;
pub mod md;
pub mod memclient;
pub mod palette;
pub mod pane;
pub mod pane_chat;
pub mod pane_agents;
pub mod pane_memory;
pub mod pane_logs;
pub mod pane_skills;
pub mod rpc;
pub mod theme;
