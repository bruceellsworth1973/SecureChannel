# The boundary crate

Every crate in `rust/` takes rust-policy's lint table unchanged (`[lints] workspace = true`), `unsafe_code` at
`forbid`, except `securechannel-dialect-c`, the C ABI Swift links. It carries the workspace's table, copied whole,
with exactly these set to `allow`:

| lint | why |
|---|---|
| `unsafe_code` | a C ABI takes raw pointers: `#[unsafe(no_mangle)]` exports, and the blocks below |
| `clippy::undocumented_unsafe_blocks` | the contracts are written here, as no `.rs` file holds comments |

The `unsafe` blocks, and the contract each relies on:

| where | contract |
|---|---|
| `bytes`: `slice::from_raw_parts(start, length)` | the caller passes `length` readable bytes at a non-null `start` that stay valid for the call; null or zero length is read as empty |
| `dialect`: `found.as_mut()` | `found` is null or a pointer `sc_dialect_new` returned and `sc_dialect_free` has not freed, used from one thread at a time (the Swift client is main-actor bound) |
| `sc_dialect_free`: `Box::from_raw(found)` | the same pointer, freed once |
| `sc_dialect_next_action`: `action.as_mut()` | `action` is null or points to a writable `ScAction`; the pointers it is given stay valid until the next `sc_dialect_next_action` or `sc_dialect_free` on that dialect |

The dialect itself, its frames, envelopes, handshake, calls and streams, is the crate `securechannel-dialect`, held to
everything.
