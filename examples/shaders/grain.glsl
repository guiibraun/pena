// Film grain: moving photographic noise and a soft vignette. Effect, animated.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @content */
uniform sampler2D u_content;
/** @label Grain @default 0.25 @range 0, 1 */
uniform float u_amount;
/** @label Grain size @default 1.5 @range 1, 6 */
uniform float u_size;
/** @label Vignette @default 0.3 @range 0, 1 */
uniform float u_vignette;

float hash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec4 c = texture2D(u_content, uv);
  vec3 rgb = c.rgb / max(c.a, 0.0001);
  float n = hash(vec3(floor(gl_FragCoord.xy / u_size), floor(u_time * 24.0))) - 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb += n * u_amount * (1.0 - abs(l - 0.5));
  rgb *= 1.0 - u_vignette * smoothstep(0.35, 1.0, length(uv - 0.5) * 1.414);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}
