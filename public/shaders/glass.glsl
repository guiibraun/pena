// Liquid glass: frosted, refracting glass over whatever is behind the shape. Fill.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @backdrop */
uniform sampler2D u_backdrop;
/** @sdf */
uniform sampler2D u_sdf;
/** @label Refraction @default 24 @range 0, 120 */
uniform float u_refraction;
/** @label Edge width @default 28 @range 2, 160 */
uniform float u_edge;
/** @label Frost @default 6 @range 0, 24 */
uniform float u_blur;
/** @label Dispersion @default 0.15 @range 0, 1 */
uniform float u_dispersion;
/** @label Tint @color @default #FFFFFF1F */
uniform vec4 u_tint;
/** @label Highlight @default 0.5 @range 0, 1.5 */
uniform float u_highlight;

vec3 frosted(vec2 p) {
  vec3 acc = vec3(0.0);
  for (int i = -2; i <= 2; i++)
    for (int j = -2; j <= 2; j++)
      acc += texture2D(u_backdrop, (p + vec2(float(i), float(j)) * u_blur * 0.5) / u_resolution).rgb;
  return acc / 25.0;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 s = texture2D(u_sdf, p / u_resolution);
  float e = 1.0 - clamp(s.r / u_edge, 0.0, 1.0);
  vec2 bend = -s.gb * e * e * u_refraction;
  vec3 rgb = vec3(frosted(p + bend * (1.0 + u_dispersion)).r, frosted(p + bend).g, frosted(p + bend * (1.0 - u_dispersion)).b);
  rgb = mix(rgb, u_tint.rgb, u_tint.a);
  float rim = 1.0 - smoothstep(0.0, max(2.0, u_edge * 0.25), s.r);
  float lit = dot(s.gb, normalize(vec2(1.0, -1.0)));
  rgb += rim * (max(lit, 0.0) * u_highlight + max(-lit, 0.0) * u_highlight * 0.35);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
