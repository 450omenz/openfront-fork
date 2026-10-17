//! Hot simulation kernels for the OpenFront engine (fork), built to
//! `wasm32-unknown-unknown` and loaded by `packages/engine/src/wasm/Kernels.ts`.
//!
//! Rules every kernel follows, so the TypeScript fallback and the WASM build
//! give bit-identical results on every client:
//! - integer math only (no floats);
//! - the same traversal order as the TypeScript it replaces;
//! - no allocation inside the kernel: callers pass buffers carved out of
//!   linear memory with `kernel_alloc`.
//!
//! See docs/ForkExtending.md, "Adding a WASM kernel".
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(target_arch = "wasm32")]
mod alloc {
    use core::arch::wasm32;

    extern "C" {
        static __heap_base: u8;
    }

    static mut HEAP_TOP: usize = 0;

    /// Bump-allocates `bytes` (16-byte aligned) of linear memory, growing it
    /// when needed. Returns 0 when memory can't grow. Never frees: callers
    /// keep their buffers for the life of the instance.
    #[no_mangle]
    pub extern "C" fn kernel_alloc(bytes: usize) -> usize {
        unsafe {
            if HEAP_TOP == 0 {
                HEAP_TOP = core::ptr::addr_of!(__heap_base) as usize;
            }
            let ptr = (HEAP_TOP + 15) & !15;
            let end = ptr + bytes;
            let have = wasm32::memory_size(0) * 65536;
            if end > have {
                let pages = (end - have + 65535) / 65536;
                if wasm32::memory_grow(0, pages) == usize::MAX {
                    return 0;
                }
            }
            HEAP_TOP = end;
            ptr
        }
    }
}

/// Splits a player's border into 8-connected clusters: the WASM twin of
/// `PlayerExecution.calculateClusters` + `floodFillWithGen` (diagonal, with
/// "is a border tile" as the include test).
///
/// - `visited`: one u32 per map tile, owned by the kernel instance; stamps are
///   generation numbers, so it is never cleared between calls.
/// - `border`: the border tiles in the order the engine iterates them.
/// - Outputs: `out_tiles` gets every cluster's tiles back to back, in the
///   order they were marked; `out_starts[c]` is where cluster `c` begins
///   (`out_starts[count]` = total); `out_boxes[4c..4c+4]` is its
///   `[minX, minY, maxX, maxY]`.
/// - `stack`: scratch, at least `n_border` long.
///
/// Every output and the stack must hold `n_border` entries (boxes 4×, starts
/// +1): a border tile lands in exactly one cluster. Returns the cluster count.
///
/// # Safety
/// All pointers must address buffers of the sizes above inside linear memory.
#[no_mangle]
pub unsafe extern "C" fn border_clusters(
    visited: *mut u32,
    width: u32,
    height: u32,
    border: *const u32,
    n_border: u32,
    border_gen: u32,
    current_gen: u32,
    out_tiles: *mut u32,
    out_starts: *mut u32,
    out_boxes: *mut i32,
    stack: *mut u32,
) -> u32 {
    let n = n_border as usize;
    let border = core::slice::from_raw_parts(border, n);
    let total = (width as usize) * (height as usize);
    let visited = core::slice::from_raw_parts_mut(visited, total);
    let out_tiles = core::slice::from_raw_parts_mut(out_tiles, n);
    let out_starts = core::slice::from_raw_parts_mut(out_starts, n + 1);
    let out_boxes = core::slice::from_raw_parts_mut(out_boxes, 4 * n);
    let stack = core::slice::from_raw_parts_mut(stack, n);
    border_clusters_impl(
        visited, width, height, border, border_gen, current_gen, out_tiles,
        out_starts, out_boxes, stack,
    )
}

/// Safe core of [`border_clusters`], also used by the native unit tests.
#[allow(clippy::too_many_arguments)]
pub fn border_clusters_impl(
    visited: &mut [u32],
    width: u32,
    height: u32,
    border: &[u32],
    border_gen: u32,
    current_gen: u32,
    out_tiles: &mut [u32],
    out_starts: &mut [u32],
    out_boxes: &mut [i32],
    stack: &mut [u32],
) -> u32 {
    let w = width;
    let last_row = (height - 1) * w;

    for &t in border {
        visited[t as usize] = border_gen;
    }

    let mut written = 0usize;
    let mut clusters = 0usize;
    for &start in border {
        if visited[start as usize] == current_gen {
            continue;
        }
        out_starts[clusters] = written as u32;
        // Start tile: a border tile not yet in a cluster.
        visited[start as usize] = current_gen;
        out_tiles[written] = start;
        written += 1;
        let mut sp = 0usize;
        stack[sp] = start;
        sp += 1;
        let (sx, sy) = ((start % w) as i32, (start / w) as i32);
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (sx, sy, sx, sy);

        while sp > 0 {
            sp -= 1;
            let tile = stack[sp];
            let x = tile % w;
            let has_n = tile >= w;
            let has_s = tile < last_row;
            // Same order as GameMapImpl.neighbors8.
            let mut nbuf = [0u32; 8];
            let mut nn = 0usize;
            if x != 0 {
                if has_n {
                    nbuf[nn] = tile - 1 - w;
                    nn += 1;
                }
                nbuf[nn] = tile - 1;
                nn += 1;
                if has_s {
                    nbuf[nn] = tile - 1 + w;
                    nn += 1;
                }
            }
            if has_n {
                nbuf[nn] = tile - w;
                nn += 1;
            }
            if has_s {
                nbuf[nn] = tile + w;
                nn += 1;
            }
            if x != w - 1 {
                if has_n {
                    nbuf[nn] = tile + 1 - w;
                    nn += 1;
                }
                nbuf[nn] = tile + 1;
                nn += 1;
                if has_s {
                    nbuf[nn] = tile + 1 + w;
                    nn += 1;
                }
            }
            for &nb in &nbuf[..nn] {
                let v = visited[nb as usize];
                if v != border_gen {
                    // Either already in a cluster (current_gen) or not a
                    // border tile.
                    continue;
                }
                visited[nb as usize] = current_gen;
                out_tiles[written] = nb;
                written += 1;
                stack[sp] = nb;
                sp += 1;
                let nx = (nb % w) as i32;
                let ny = (nb / w) as i32;
                if nx < min_x {
                    min_x = nx;
                }
                if ny < min_y {
                    min_y = ny;
                }
                if nx > max_x {
                    max_x = nx;
                }
                if ny > max_y {
                    max_y = ny;
                }
            }
        }
        out_boxes[4 * clusters] = min_x;
        out_boxes[4 * clusters + 1] = min_y;
        out_boxes[4 * clusters + 2] = max_x;
        out_boxes[4 * clusters + 3] = max_y;
        clusters += 1;
    }
    out_starts[clusters] = written as u32;
    clusters as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_diagonal_tiles_are_one_cluster_and_far_ones_are_not() {
        // 5x5 map: tiles (0,0) and (1,1) touch diagonally; (4,4) is alone.
        let (w, h) = (5u32, 5u32);
        let border = [0u32, 6, 24];
        let mut visited = vec![0u32; 25];
        let mut out = vec![0u32; 3];
        let mut starts = vec![0u32; 4];
        let mut boxes = vec![0i32; 12];
        let mut stack = vec![0u32; 3];
        let n = border_clusters_impl(
            &mut visited, w, h, &border, 1, 2, &mut out, &mut starts, &mut boxes,
            &mut stack,
        );
        assert_eq!(n, 2);
        assert_eq!(&out[..], &[0, 6, 24]);
        assert_eq!(&starts[..3], &[0, 2, 3]);
        assert_eq!(&boxes[..8], &[0, 0, 1, 1, 4, 4, 4, 4]);
    }
}
