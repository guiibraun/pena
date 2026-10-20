// Halftone: print-style dots that grow with the darkness of the layer. Effect.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @content */
uniform sampler2D u_content;
/** @label Dot size @default 10 @range 3, 60 */
uniform float u_size;
/** @label Angle @default 45 @range -90, 90 */
uniform float u_angle;
/** @label Ink @color @default #111111FF */
uniform vec4 u_ink;
/** @label Paper @color @default #F4F1EAFF */
uniform vec4 u_paper;
/** @label Image colors @default false */
uniform bool u_colored;

void main() {
  vec2 p = gl_FragCoord.xy;
  float a = radians(u_angle);
  mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
  vec2 q = rot * p;
  vec2 cell = (floor(q / u_size) + 0.5) * u_size;
  vec2 center = cell * rot;
  vec4 s = texture2D(u_content, center / u_resolution);
  vec3 rgb = s.rgb / max(s.a, 0.0001);
  float dark = (1.0 - dot(rgb, vec3(0.2126, 0.7152, 0.0722))) * s.a;
  float radius = sqrt(dark) * u_size * 0.62;
  float ink = 1.0 - smoothstep(radius - 0.75, radius + 0.75, length(q - cell));
  vec4 inkColor = u_colored ? vec4(rgb, 1.0) : u_ink;
  vec4 paper = vec4(u_paper.rgb * u_paper.a, u_paper.a);
  vec4 dotColor = vec4(inkColor.rgb * inkColor.a, inkColor.a);
  float coverage = texture2D(u_content, p / u_resolution).a;
  gl_FragColor = mix(paper, dotColor, ink) * coverage;
}
