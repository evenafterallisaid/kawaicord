"""draw the windows setup art as 24-bit bmps for nsis."""
from pathlib import Path
import struct

OUT = Path(__file__).resolve().parents[1] / 'src-tauri' / 'installer'
SCALE = 3
INK = (55, 42, 78)
CREAM = (255, 249, 253)
PINK = (255, 168, 198)
LAVENDER = (198, 174, 255)


def paint(width, height, draw):
    stride = (width * 3 + 3) & ~3
    pixels = bytearray(stride * height)
    for y in range(height):
        for x in range(width):
            samples = [
                draw(x + (a + .5) / SCALE, y + (b + .5) / SCALE)
                for a in range(SCALE) for b in range(SCALE)
            ]
            offset = (height - y - 1) * stride + x * 3
            pixels[offset:offset + 3] = bytes(sum(c[i] for c in samples) // len(samples) for i in (2, 1, 0))
    return struct.pack('<2sIHHI', b'BM', 54 + len(pixels), 0, 0, 54) + struct.pack(
        '<IiiHHIIiiII', 40, width, height, 1, 24, 0, len(pixels), 2835, 2835, 0, 0
    ) + pixels


def art(x, y, frame=0):
    # the base art lives in 164 x 314 coordinates.
    t = y / 314
    color = tuple(round(a + (b - a) * t) for a, b in zip((238, 229, 255), (255, 217, 235)))

    def ellipse(cx, cy, rx, ry, fill):
        nonlocal color
        if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1:
            color = fill

    def rounded(cx, cy, half_w, half_h, radius, fill):
        nonlocal color
        dx = max(abs(x - cx) - half_w + radius, 0)
        dy = max(abs(y - cy) - half_h + radius, 0)
        if dx * dx + dy * dy < radius * radius:
            color = fill

    def sparkle(cx, cy, radius, fill):
        nonlocal color
        if (abs(x - cx) / radius) ** .65 + (abs(y - cy) / radius) ** .65 < 1:
            color = fill

    for cx, cy, radius in [(16, 38, 2), (131, 44, 3), (35, 70, 2), (145, 227, 2),
                           (22, 253, 3), (112, 274, 2), (74, 291, 2), (29, 198, 2)]:
        ellipse(cx, cy, radius, radius, (255, 248, 253))
    ellipse(81, 153, 62, 62, (255, 238, 249))
    sparkle(33, 112, (9, 13, 6)[frame], (150, 108, 221))
    sparkle(130, 123, (13, 7, 11)[frame], (226, 111, 156))
    sparkle(122, 192, (7, 10, 13)[frame], (151, 112, 221))
    sparkle(47, 207, (6, 9, 5)[frame], (217, 103, 148))
    ellipse(81, 188, 39, 7, (225, 196, 239))
    ellipse(113, 156, 14, 13, INK)
    ellipse(113, 156, 9, 8, CREAM)
    ellipse(63, 122, 10, 23, INK)
    ellipse(96, 122, 10, 23, INK)
    ellipse(63, 122, 7, 20, CREAM)
    ellipse(96, 122, 7, 20, CREAM)
    ellipse(63, 116, 3.5, 11, PINK)
    ellipse(96, 116, 3.5, 11, PINK)
    rounded(79, 154, 34, 30, 21, INK)
    rounded(79, 154, 31, 27, 18, CREAM)
    rounded(79, 177, 15, 3, 3, LAVENDER)
    ellipse(57, 160, 5, 3, PINK)
    ellipse(101, 160, 5, 3, PINK)
    ellipse(65, 153, 3.2, 3.7, INK)
    ellipse(93, 153, 4 if frame == 1 else 3.2, 1.3 if frame == 1 else 3.7, INK)
    ellipse(79, 158, 3, 2, INK)
    return color


def header(x, y):
    if x >= 99:
        return art(15 + (x - 99) * 2.55, 82 + y * 2.55)
    t = x / 99
    return tuple(round(a + (b - a) * t) for a, b in zip((255, 255, 255), (249, 235, 252)))


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    for frame, name in enumerate(('sidebar', 'blink', 'sparkle')):
        (OUT / f'{name}.bmp').write_bytes(paint(164, 314, lambda x, y: art(x, y, frame)))
    (OUT / 'header.bmp').write_bytes(paint(150, 57, header))
