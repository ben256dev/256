#!/home/benjamin/kasa-env/bin/python

import asyncio
import argparse
from kasa.iot import IotBulb
import colorsys

def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        hex_color = ''.join(c * 2 for c in hex_color)
    r, g, b = [int(hex_color[i:i+2], 16) for i in (0, 2, 4)]
    return r, g, b

def rgb_to_hsv(r, g, b):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return int(h * 360), int(s * 100)

from kasa.iot import IotBulb

async def control_bulb(ip, brightness=None, temp=None, hex_color=None, turn_off=False):
    bulb = IotBulb(ip)
    await bulb.update()

    if turn_off: 
        await bulb.turn_off() 
        print(f"[{ip}] Turned OFF") 
        return

    light = bulb.modules["Light"]
    tasks = []

    if brightness is not None:
        tasks.append(light.set_brightness(brightness))

    if temp is not None:
        clamped_temp = max(2500, min(6500, temp))
        if clamped_temp != temp:
            print(f"[{ip}] WARNING: Color temperature {temp}K out of range (2500–6500). Clamped to {clamped_temp}K.")
        tasks.append(light.set_color_temp(clamped_temp))

    elif hex_color:
        r, g, b = hex_to_rgb(hex_color)
        hue, sat = rgb_to_hsv(r, g, b)
        tasks.append(light.set_hsv(hue, sat, brightness or light.brightness))

    if tasks:
        await asyncio.gather(*tasks)
        await bulb.turn_on()
        print(f"[{ip}] Set brightness={brightness}, temp={temp}, color={hex_color}")
    else:
        await bulb.turn_on()
        print(f"[{ip}] Turned ON")

async def main(args):
    await asyncio.gather(*[
        control_bulb(
            ip,
            brightness=args.brightness,
            temp=args.temp,
            hex_color=args.color,
            turn_off=args.off
        )
        for ip in args.ip
    ])

def cli():
    parser = argparse.ArgumentParser(description="Control one or more Kasa Smart Bulbs")
    parser.add_argument("ip", nargs="+", help="One or more bulb IPs")
    parser.add_argument("--brightness", type=int, help="Brightness (0–100)")
    parser.add_argument("--temp", type=int, help="Color temperature (2500–9000 K)")
    parser.add_argument("--color", help="Hex color (e.g., ff0000 or f00)")
    parser.add_argument("--off", action="store_true", help="Turn bulb(s) off")

    args = parser.parse_args()
    asyncio.run(main(args))

if __name__ == "__main__":
    cli()

