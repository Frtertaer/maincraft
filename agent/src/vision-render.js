import { createCanvas } from "canvas";
import { Vec3 } from "vec3";

/** Approximate block palette for a cheap first-person JPEG (not Minecraft textures). */
const BLOCK_COLORS = {
  air: null,
  cave_air: null,
  void_air: null,
  water: [40, 90, 200],
  lava: [220, 90, 20],
  grass_block: [90, 150, 55],
  dirt: [130, 90, 55],
  coarse_dirt: [110, 75, 45],
  rooted_dirt: [115, 80, 50],
  podzol: [90, 65, 40],
  mud: [70, 60, 55],
  stone: [125, 125, 125],
  cobblestone: [110, 110, 110],
  mossy_cobblestone: [95, 110, 90],
  deepslate: [70, 70, 75],
  cobbled_deepslate: [65, 65, 70],
  granite: [150, 110, 95],
  diorite: [180, 180, 180],
  andesite: [130, 130, 130],
  gravel: [120, 115, 110],
  sand: [210, 195, 140],
  red_sand: [180, 110, 60],
  sandstone: [200, 185, 130],
  bedrock: [40, 40, 40],
  oak_log: [100, 80, 50],
  spruce_log: [70, 55, 35],
  birch_log: [200, 195, 175],
  jungle_log: [90, 70, 40],
  acacia_log: [110, 70, 40],
  dark_oak_log: [55, 40, 25],
  cherry_log: [70, 55, 55],
  mangrove_log: [80, 55, 40],
  oak_leaves: [55, 120, 45],
  spruce_leaves: [40, 90, 45],
  birch_leaves: [70, 130, 55],
  jungle_leaves: [45, 110, 40],
  acacia_leaves: [90, 130, 40],
  dark_oak_leaves: [40, 80, 35],
  cherry_leaves: [220, 150, 180],
  azalea_leaves: [60, 120, 50],
  flowering_azalea_leaves: [70, 125, 55],
  oak_planks: [160, 130, 80],
  spruce_planks: [115, 85, 50],
  birch_planks: [195, 180, 130],
  glass: [180, 210, 230],
  ice: [160, 200, 230],
  packed_ice: [140, 180, 220],
  snow: [235, 240, 245],
  snow_block: [235, 240, 245],
  coal_ore: [90, 90, 90],
  iron_ore: [140, 125, 110],
  copper_ore: [130, 120, 100],
  gold_ore: [150, 140, 90],
  diamond_ore: [100, 160, 170],
  deepslate_coal_ore: [55, 55, 60],
  deepslate_iron_ore: [80, 75, 70],
  deepslate_copper_ore: [75, 70, 65],
  deepslate_gold_ore: [90, 85, 60],
  deepslate_diamond_ore: [55, 90, 100],
  crafting_table: [140, 100, 55],
  furnace: [100, 100, 100],
  chest: [140, 100, 40],
  torch: [250, 220, 80],
  wall_torch: [250, 220, 80],
  clay: [150, 155, 165],
  sugar_cane: [90, 160, 70],
  cactus: [70, 130, 60],
  pumpkin: [210, 130, 30],
  melon: [90, 160, 50],
  obsidian: [25, 15, 40],
  crying_obsidian: [40, 15, 55],
  netherrack: [120, 50, 50],
  soul_sand: [70, 55, 45],
  glowstone: [250, 220, 120],
  end_stone: [210, 205, 140],
  terracotta: [150, 90, 70],
  white_wool: [230, 230, 230],
  orange_wool: [230, 130, 40],
  magenta_wool: [180, 70, 180],
  light_blue_wool: [100, 160, 220],
  yellow_wool: [230, 210, 50],
  lime_wool: [120, 200, 40],
  pink_wool: [230, 150, 170],
  gray_wool: [90, 90, 90],
  light_gray_wool: [150, 150, 150],
  cyan_wool: [30, 140, 150],
  purple_wool: [130, 50, 180],
  blue_wool: [50, 70, 180],
  brown_wool: [110, 70, 40],
  green_wool: [70, 100, 30],
  red_wool: [170, 40, 40],
  black_wool: [30, 30, 30],
};

const SKY = [140, 185, 235];
const VOID = [20, 20, 28];

function getViewDirection(pitch, yaw) {
  const csPitch = Math.cos(pitch);
  const snPitch = Math.sin(pitch);
  const csYaw = Math.cos(yaw);
  const snYaw = Math.sin(yaw);
  return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch);
}

function blockColor(name) {
  if (!name) return [80, 80, 80];
  if (Object.prototype.hasOwnProperty.call(BLOCK_COLORS, name)) {
    return BLOCK_COLORS[name];
  }
  if (name.endsWith("_log") || name.endsWith("_wood") || name.endsWith("_stem")) return [95, 70, 40];
  if (name.endsWith("_leaves") || name.includes("leaves")) return [55, 120, 45];
  if (name.endsWith("_planks")) return [150, 120, 70];
  if (name.endsWith("_ore")) return [120, 120, 110];
  if (name.includes("dirt") || name.includes("mud")) return [120, 85, 50];
  if (name.includes("stone") || name.includes("deepslate") || name.includes("rock")) return [120, 120, 120];
  if (name.includes("sand")) return [205, 190, 135];
  if (name.includes("water")) return [40, 90, 200];
  if (name.includes("lava")) return [220, 90, 20];
  if (name.includes("glass")) return [180, 210, 230];
  if (name.includes("wool") || name.includes("carpet")) return [180, 180, 180];
  if (name.includes("nether")) return [110, 45, 45];
  if (name.includes("end")) return [200, 195, 140];
  // Stable pseudo-color from name hash so unknown blocks still look distinct.
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return [80 + (h & 0x7f), 70 + ((h >> 8) & 0x7f), 60 + ((h >> 16) & 0x7f)];
}

function shadeColor(rgb, face, distance, maxDistance) {
  if (!rgb) return null;
  let faceMul = 1;
  // prismarine face: 0=-y 1=+y 2=-z 3=+z 4=-x 5=+x (common)
  if (face === 0) faceMul = 0.55;
  else if (face === 1) faceMul = 1.0;
  else if (face === 2 || face === 3) faceMul = 0.8;
  else if (face === 4 || face === 5) faceMul = 0.7;
  const fog = Math.min(1, Math.max(0, distance / maxDistance));
  const light = faceMul * (1 - fog * 0.65);
  const skyMix = fog * fog * 0.35;
  return [
    Math.round(rgb[0] * light * (1 - skyMix) + SKY[0] * skyMix),
    Math.round(rgb[1] * light * (1 - skyMix) + SKY[1] * skyMix),
    Math.round(rgb[2] * light * (1 - skyMix) + SKY[2] * skyMix),
  ];
}

/**
 * Render a cheap first-person JPEG from the bot world (no desktop capture).
 * @returns {{ buffer: Buffer, width: number, height: number, rays: number, ms: number }}
 */
export function renderBotPov(bot, options = {}) {
  const width = Math.max(64, Math.min(640, Number(options.width) || 320));
  const height = Math.max(48, Math.min(360, Number(options.height) || 180));
  const maxDistance = Math.max(8, Math.min(96, Number(options.maxDistance) || 48));
  const quality = Math.max(0.3, Math.min(0.95, Number(options.jpegQuality) || 0.72));
  const fov = Number(options.fov) || Math.PI / 2.4;

  if (!bot?.entity?.position || !bot.world?.raycast) {
    throw new Error("bot world is not ready for POV render");
  }

  const started = Date.now();
  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  const eyeY = bot.entity.eyeHeight ?? Math.max(0.1, (bot.entity.height || 1.8) - 0.18);
  const eye = bot.entity.position.offset(0, eyeY, 0);
  const forward = getViewDirection(pitch, yaw).normalize();
  // Camera basis: right = forward × worldUp, up = right × forward
  const worldUp = new Vec3(0, 1, 0);
  let right = forward.cross(worldUp);
  if (right.norm() < 1e-6) {
    right = new Vec3(1, 0, 0);
  } else {
    right = right.normalize();
  }
  const up = right.cross(forward).normalize();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const aspect = width / height;
  const tanHalf = Math.tan(fov / 2);
  let rays = 0;

  for (let y = 0; y < height; y += 1) {
    const v = (1 - (2 * (y + 0.5)) / height) * tanHalf;
    for (let x = 0; x < width; x += 1) {
      const u = ((2 * (x + 0.5)) / width - 1) * tanHalf * aspect;
      const dir = forward.plus(right.scaled(u)).plus(up.scaled(v)).normalize();
      rays += 1;

      let rgb = null;
      try {
        const hit = bot.world.raycast(eye, dir, maxDistance);
        if (hit) {
          const name = hit.name || hit.displayName || "stone";
          const base = blockColor(name);
          if (base) {
            const dist = eye.distanceTo(hit.position.offset(0.5, 0.5, 0.5));
            rgb = shadeColor(base, hit.face, dist, maxDistance);
          }
        }
      } catch {
        rgb = null;
      }

      if (!rgb) {
        // Sky gradient above horizon, darker void below.
        const skyT = Math.max(0, Math.min(1, (dir.y + 0.15) / 1.15));
        rgb = [
          Math.round(VOID[0] + (SKY[0] - VOID[0]) * skyT),
          Math.round(VOID[1] + (SKY[1] - VOID[1]) * skyT),
          Math.round(VOID[2] + (SKY[2] - VOID[2]) * skyT),
        ];
      }

      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  // Tiny HUD strip so the model knows this is a synthetic POV, not a photo.
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, height - 16, width, 16);
  ctx.fillStyle = "#e8e8e8";
  ctx.font = "10px sans-serif";
  const pos = bot.entity.position;
  ctx.fillText(
    `POV ${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)} yaw=${yaw.toFixed(2)}`,
    4,
    height - 5
  );

  const buffer = canvas.toBuffer("image/jpeg", { quality, progressive: false, chromaSubsampling: true });
  return {
    buffer,
    width,
    height,
    rays,
    ms: Date.now() - started,
    bytes: buffer.length,
  };
}
