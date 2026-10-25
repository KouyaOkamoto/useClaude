//! 粒子シミュレーションの WebAssembly 版。
//! engine.js の JS 版と同じ計算をするので、変更するときは両方そろえること。
//!
//! JS からは world_new で作った World のポインタを受け取り、以降の関数に渡して使う。
//! 画素は RGBA のバイト列（u32 で見ると 0xAABBGGRR）で、JS 側がそのまま ImageData にする。

const SOFTEN: f32 = 400.0;        // 指のすぐ近くで力が無限大にならないための補正 (px²)
const ATTRACT: f32 = 200_000.0;   // 引き寄せる強さ
const BURST: f32 = 1500.0;        // はじく強さ (px/s)
const BURST_RANGE: f32 = 150.0;   // はじく力が半分になる距離 (px)
const BOUNCE: f32 = 0.6;          // 画面の端での跳ね返り
const MAX_SPEED: f32 = 1500.0;    // 色が一番明るくなる速さ (px/s)

pub struct World {
    w: u32,
    h: u32,
    pos: Vec<f32>, // x0, y0, x1, y1, ...
    vel: Vec<f32>,
    pixels: Vec<u32>,
    palette: [u32; 256], // 速さごとに足し込む色。JS 側が書き込む
}

#[no_mangle]
pub extern "C" fn world_new(n: u32, w: u32, h: u32, seed: u32) -> *mut World {
    // xorshift32
    let mut s = seed | 1;
    let mut rand = move || {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        s as f32 / 4_294_967_296.0
    };
    let mut pos = Vec::with_capacity(n as usize * 2);
    for _ in 0..n {
        pos.push(rand() * w as f32);
        pos.push(rand() * h as f32);
    }
    let world = World {
        w,
        h,
        pos,
        vel: vec![0.0; n as usize * 2],
        pixels: vec![0xff00_0000; (w * h) as usize],
        palette: [0; 256],
    };
    Box::into_raw(Box::new(world))
}

/// # Safety
/// world_new で作ったポインタを1回だけ渡すこと。
#[no_mangle]
pub unsafe extern "C" fn world_free(world: *mut World) {
    drop(Box::from_raw(world));
}

/// # Safety
/// world_new で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn world_pixels(world: *mut World) -> *const u32 {
    (*world).pixels.as_ptr()
}

/// # Safety
/// world_new で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn world_palette(world: *mut World) -> *mut u32 {
    (*world).palette.as_mut_ptr()
}

/// 1フレーム進めて画素を描き直す。
/// damp: 速度に掛ける減衰、fade: 残像の残り具合 (0..=256)、
/// mode: 0 = 何もしない、1 = (px, py) へ引き寄せ、2 = (px, py) からはじく
///
/// # Safety
/// world_new で作った有効なポインタを渡すこと。
#[no_mangle]
pub unsafe extern "C" fn world_step(world: *mut World, dt: f32, damp: f32, fade: u32, px: f32, py: f32, mode: u32) {
    (*world).step(dt, damp, fade, px, py, mode);
}

impl World {
    fn step(&mut self, dt: f32, damp: f32, fade: u32, px: f32, py: f32, mode: u32) {
        for p in self.pixels.iter_mut() {
            let c = *p;
            let rb = (((c & 0x00ff_00ff) * fade) >> 8) & 0x00ff_00ff;
            let g = (((c & 0x0000_ff00) * fade) >> 8) & 0x0000_ff00;
            *p = 0xff00_0000 | rb | g;
        }

        let (w, h) = (self.w as f32, self.h as f32);
        let stride = self.w as usize;
        for (pos, vel) in self.pos.chunks_exact_mut(2).zip(self.vel.chunks_exact_mut(2)) {
            let (mut x, mut y) = (pos[0], pos[1]);
            let (mut vx, mut vy) = (vel[0], vel[1]);

            if mode != 0 {
                let dx = px - x;
                let dy = py - y;
                let d2 = dx * dx + dy * dy + SOFTEN;
                if mode == 1 {
                    let f = ATTRACT * dt / d2;
                    vx += dx * f;
                    vy += dy * f;
                } else {
                    let d = d2.sqrt();
                    let f = BURST * BURST_RANGE / ((d + BURST_RANGE) * d);
                    vx -= dx * f;
                    vy -= dy * f;
                }
            }

            vx *= damp;
            vy *= damp;
            x += vx * dt;
            y += vy * dt;
            if x < 0.0 {
                x = -x;
                vx = -vx * BOUNCE;
            } else if x >= w {
                x = 2.0 * w - x;
                vx = -vx * BOUNCE;
            }
            if y < 0.0 {
                y = -y;
                vy = -vy * BOUNCE;
            } else if y >= h {
                y = 2.0 * h - y;
                vy = -vy * BOUNCE;
            }
            x = x.clamp(0.0, w - 0.01);
            y = y.clamp(0.0, h - 0.01);

            pos[0] = x;
            pos[1] = y;
            vel[0] = vx;
            vel[1] = vy;

            let speed = (vx * vx + vy * vy).sqrt();
            let color = self.palette[((speed * (255.0 / MAX_SPEED)) as usize).min(255)];
            let p = &mut self.pixels[y as usize * stride + x as usize];
            let r = ((*p & 0xff) + (color & 0xff)).min(0xff);
            let g = (((*p >> 8) & 0xff) + ((color >> 8) & 0xff)).min(0xff);
            let b = (((*p >> 16) & 0xff) + ((color >> 16) & 0xff)).min(0xff);
            *p = 0xff00_0000 | (b << 16) | (g << 8) | r;
        }
    }
}
