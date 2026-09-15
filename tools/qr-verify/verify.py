"""
QR encoder verification harness.

WHY THIS EXISTS: `unity/host/Assets/Scripts/Util/QrCode.cs` is a hand-written QR
encoder, and the Phase 4 specification is explicit that generating an image is
NOT evidence a code scans. A QR code can look perfectly plausible — right size,
right finder squares, right quiet zone — and still be unreadable. Only a decoder
settles it.

`qr_port.py` is a line-by-line port of the C#. This script renders its output
and decodes it with OpenCV's detector, so the algorithm can be verified without
a Unity build, a phone or a camera.

    pip install opencv-python-headless numpy
    python tools/qr-verify/verify.py

Keep the port in step with the C# whenever the encoder changes.

WHAT IT CAUGHT (all invisible to inspection, all fixed):
  1. Format-information bits 6 and 7 placed in the wrong modules, which made
     every code unreadable.
  2. Mask penalty rule 3 matching the finder-like pattern in only one
     orientation, which selected weaker masks than the spec intends.
  3. Mask 2 (vertical stripes) producing spec-valid codes that OpenCV fails to
     decode about 6.5% of the time. Confirmed as a decoder-population problem
     rather than an encoder fault, by forcing an independent reference encoder
     to mask 2 and watching it fail identically. Mask 2 is now excluded.
"""

import random
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    print("Needs: pip install opencv-python-headless numpy")
    sys.exit(1)

import qr_port

ALPHABET = "ABCDEFGHJKMNPQRTWXY346789"  # must match packages/protocol/src/room-code.ts


def render(grid, scale=8, quiet_modules=4):
    """Render a grid to a greyscale image, with the mandatory quiet zone."""
    size = len(grid)
    quiet = quiet_modules * scale
    img = np.ones((size * scale + 2 * quiet,) * 2, dtype=np.uint8) * 255
    for y in range(size):
        for x in range(size):
            if grid[y][x]:
                img[quiet + y * scale:quiet + (y + 1) * scale,
                    quiet + x * scale:quiet + (x + 1) * scale] = 0
    return img


def check(detector, text):
    grid = qr_port.encode(text)
    if grid is None:
        return False, 0, "encoder returned nothing"
    decoded, _, _ = detector.detectAndDecode(render(grid))
    return decoded == text, len(grid), decoded


def main():
    detector = cv2.QRCodeDetector()

    cases = [
        # The shapes this actually has to carry.
        "http://192.168.1.10:3000/join/BX7K",
        "http://localhost:3000/join/QQQQ",
        "http://10.0.0.42:3000/join/WXYZ",
        "https://identify-genetics-popularity-explains.trycloudflare.com/join/AB34",
        "https://" + "x" * 40 + ".trycloudflare.com/join/BX7K",
        # Boundaries: shortest plausible, and a single character.
        "http://a.b:3000/join/AAAA",
        "A",
    ]

    # A spread of real room codes across several host shapes.
    random.seed(11)
    hosts = ["192.168.1.137", "10.0.0.42", "localhost", "192.168.0.101"]
    for i in range(300):
        code = "".join(random.choice(ALPHABET) for _ in range(4))
        cases.append(f"http://{hosts[i % len(hosts)]}:3000/join/{code}")

    failures = []
    sizes = set()
    for text in cases:
        ok, size, decoded = check(detector, text)
        sizes.add(size)
        if not ok:
            failures.append((text, decoded))

    print(f"{len(cases) - len(failures)}/{len(cases)} decoded correctly")
    print(f"symbol sizes exercised: {sorted(s for s in sizes if s)}")

    for text, decoded in failures[:10]:
        print(f"  FAIL {text!r} -> {decoded!r}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
