// CRT: curved glass, scanlines, phosphor mask and glow of an old monitor. Effect, animated.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @content */
uniform sampler2D u_content;
/** @label Curvature @default 0.25 @range 0, 1 */
uniform float u_curve;
/** @label Scanlines @default 0.5 @range 0, 1 */
uniform float u_scan;
/** @label Line size @default 3 @range 1.5, 12 */
uniform float u_line;
/** @label Phosphor mask @default 0.3 @range 0, 1 */
uniform float u_mask;
/** @label Glow @default 0.4 @range 0, 1.5 */
uniform float u_glow;
/** @label Flicker @default 0.15 @range 0, 1 */
uniform float u_flicker;

vec4 tap(vec2 uv) { return texture2D(u_content, uv); }

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 cc = uv - 0.5;
  uv = 0.5 + cc * (1.0 + u_curve * dot(cc, cc) * 1.6);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, tap(gl_FragCoord.xy / u_resolution).a); return; }
  vec2 px = 1.5 / u_resolution;
  vec4 c = tap(uv);
  vec4 bloom = (tap(uv + vec2(px.x, 0.0)) + tap(uv - vec2(px.x, 0.0)) + tap(uv + vec2(0.0, px.y)) + tap(uv - vec2(0.0, px.y))) * 0.25;
  vec3 rgb = c.rgb + bloom.rgb * u_glow;
  float scan = 0.5 + 0.5 * cos(gl_FragCoord.y / u_line * 6.2831853);
  rgb *= 1.0 - u_scan * 0.6 * (1.0 - scan);
  float m = mod(floor(gl_FragCoord.x), 3.0);
  vec3 mask = m < 1.0 ? vec3(1.0, 0.7, 0.7) : m < 2.0 ? vec3(0.7, 1.0, 0.7) : vec3(0.7, 0.7, 1.0);
  rgb *= mix(vec3(1.0), mask, u_mask);
  rgb *= 1.0 + u_flicker * 0.06 * sin(u_time * 47.0);
  rgb *= 1.0 - smoothstep(0.42, 0.72, length(cc)) * u_curve;
  float a = max(c.a, bloom.a * u_glow);
  gl_FragColor = vec4(min(rgb, vec3(a)), a);
}
