// Glitch: torn horizontal slices and color split that jump over time. Effect, animated.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @content */
uniform sampler2D u_content;
/** @label Amount @default 0.35 @range 0, 1 */
uniform float u_amount;
/** @label Strength @default 40 @range 0, 200 */
uniform float u_strength;
/** @label Slices @default 24 @range 2, 120 */
uniform float u_slices;
/** @label Speed @default 6 @range 0, 30 */
uniform float u_speed;
/** @label Color split @default 0.6 @range 0, 1 */
uniform float u_split;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 p = gl_FragCoord.xy;
  float t = floor(u_time * u_speed);
  float band = floor(p.y / u_resolution.y * u_slices);
  float pick = hash(vec2(band, t));
  float shift = pick > 1.0 - u_amount ? (hash(vec2(band + 7.0, t)) - 0.5) * 2.0 * u_strength : 0.0;
  vec2 o = vec2(shift, 0.0);
  vec2 split = vec2(shift * u_split * 0.25 + u_split * 2.0, 0.0);
  vec4 g = texture2D(u_content, (p + o) / u_resolution);
  vec4 r = texture2D(u_content, (p + o + split) / u_resolution);
  vec4 b = texture2D(u_content, (p + o - split) / u_resolution);
  gl_FragColor = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}
