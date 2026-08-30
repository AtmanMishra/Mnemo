//! Shared internals of the `mnemo-agent` app. The binary is a thin event loop
//! over these modules, so panes, auth, sessions and the RPC protocol are all
//! testable without a terminal.
pub mod auth;
pub mod brand;
pub mod clipboard;
pub mod cockpit;
pub mod cockpit_ui;
pub mod md;
pub mod memclient;
pub mod models;
pub mod onboarding;
pub mod palette;
pub mod pane;
pub mod pane_chat;
pub mod pane_agents;
pub mod pane_memory;
pub mod pane_logs;
pub mod pane_sessions;
pub mod pane_skills;
pub mod rpc;
pub mod sessions;
pub mod theme;
