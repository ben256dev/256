#!/home/benjamin/kasa-env/bin/python

import asyncio
import argparse
import ipaddress
import json
import os
import re
import shlex
import subprocess
import sys
import colorsys
from pathlib import Path
from kasa import Credentials, Discover
from kasa.iot import IotBulb

SCRIPT_DIR = Path(__file__).resolve().parent


def load_env_file(path):
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        try:
            tokens = shlex.split(line, comments=True, posix=True)
        except ValueError:
            continue

        if tokens and tokens[0] == "export":
            tokens = tokens[1:]

        if len(tokens) != 1 or "=" not in tokens[0]:
            continue

        key, value = tokens[0].split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(SCRIPT_DIR / ".env")
load_env_file(Path("/etc/256.env"))

DISCOVERY_TIMEOUT = int(os.environ.get("KASA_DISCOVERY_TIMEOUT", "5"))
SCAN_TIMEOUT = int(os.environ.get("KASA_SCAN_TIMEOUT", "1"))
SCAN_CONCURRENCY = int(os.environ.get("KASA_SCAN_CONCURRENCY", "64"))
CACHE_PATH = Path(os.environ.get("KASA_BULB_CACHE", SCRIPT_DIR / ".bulbs.json"))
IGNORED_INTERFACES = ("docker", "br-", "veth")


def kasa_credentials():
    username = os.environ.get("KASA_USERNAME")
    password = os.environ.get("KASA_PASSWORD")
    if username and password:
        return Credentials(username, password)
    return None


def has_kasa_auth():
    return kasa_credentials() is not None


def bulb_for_host(host):
    return IotBulb(host)


async def connect_device_for_control(device):
    if not has_kasa_auth():
        return device

    return await Discover.discover_single(
        device.host,
        discovery_timeout=DISCOVERY_TIMEOUT,
        timeout=DISCOVERY_TIMEOUT,
        credentials=kasa_credentials(),
    )


def discovery_targets():
    configured_target = os.environ.get("KASA_DISCOVERY_TARGET")
    if configured_target:
        return [target.strip() for target in configured_target.split(",") if target.strip()]

    targets = []
    try:
        result = subprocess.run(
            ["ip", "-o", "-4", "addr", "show", "scope", "global"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        result = None

    if result and result.returncode == 0:
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) < 6:
                continue
            interface = parts[1]
            if interface.startswith(IGNORED_INTERFACES):
                continue
            if "brd" in parts:
                targets.append(parts[parts.index("brd") + 1])

    targets.append("255.255.255.255")
    return list(dict.fromkeys(targets))


def local_scan_hosts():
    hosts = []
    try:
        result = subprocess.run(
            ["ip", "-o", "-4", "addr", "show", "scope", "global"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return hosts

    if result.returncode != 0:
        return hosts

    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        interface = parts[1]
        if interface.startswith(IGNORED_INTERFACES):
            continue
        try:
            network = ipaddress.ip_interface(parts[3]).network
        except ValueError:
            continue
        if network.version == 4 and network.num_addresses <= 512:
            hosts.extend(str(host) for host in network.hosts())

    return list(dict.fromkeys(hosts))


def normalize_selector(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


def is_ip(value):
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def normalize_mac(value):
    return value.lower() if ":" in value else value


def split_group_value(value):
    if "," in value:
        return [item.strip() for item in value.split(",") if item.strip()]
    return value.split()


def expand_targets(targets):
    expanded = []

    for target in targets:
        group_value = os.environ.get(f"BULB_{target.upper()}")
        if group_value:
            expanded.extend(split_group_value(group_value))
        else:
            expanded.append(target)

    return expanded


def parse_actions(targets):
    action_words = {"on", "off"}
    actions = [target.lower() for target in targets if target.lower() in action_words]
    remaining_targets = [target for target in targets if target.lower() not in action_words]

    if len(set(actions)) > 1:
        raise SystemExit("Use either 'on' or 'off', not both.")

    return remaining_targets, (actions[0] if actions else None)


def load_cache():
    try:
        with CACHE_PATH.open() as file:
            data = json.load(file)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_cache(bulbs):
    data = load_cache()
    for bulb in bulbs:
        cache_key = bulb.alias or bulb.mac or bulb.device_id or bulb.host
        if not cache_key:
            continue
        existing = find_cached_entry(bulb, data)
        data[cache_key] = {
            "alias": bulb.alias or existing.get("alias"),
            "mac": bulb.mac or existing.get("mac"),
            "device_id": bulb.device_id or existing.get("device_id"),
            "host": bulb.host,
        }

    try:
        CACHE_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    except OSError:
        pass


def find_cached_entry(device, cache=None):
    cache = cache if cache is not None else load_cache()
    selectors = {
        selector
        for value in (device.alias, device.mac, device.device_id, device.host)
        if value
        for selector in (value, normalize_mac(value), normalize_selector(value))
    }

    for key, entry in cache.items():
        if not isinstance(entry, dict):
            continue
        entry_selectors = {
            selector
            for value in (key, entry.get("alias"), entry.get("mac"), entry.get("device_id"), entry.get("host"))
            if value
            for selector in (value, normalize_mac(value), normalize_selector(value))
        }
        if selectors & entry_selectors:
            return entry

    return {}


def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        hex_color = ''.join(c * 2 for c in hex_color)
    r, g, b = [int(hex_color[i:i+2], 16) for i in (0, 2, 4)]
    return r, g, b

def rgb_to_hsv(r, g, b):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return int(h * 360), int(s * 100)

def device_selectors(device):
    selectors = {device.host}
    for value in (device.alias, device.mac, device.device_id):
        if value:
            selectors.add(value)
            selectors.add(normalize_mac(value))
            selectors.add(normalize_selector(value))
    cached = find_cached_entry(device)
    for value in (cached.get("alias"), cached.get("mac"), cached.get("device_id")):
        if value:
            selectors.add(value)
            selectors.add(normalize_mac(value))
            selectors.add(normalize_selector(value))
    return selectors


async def discover_bulbs():
    devices = {}
    for target in discovery_targets():
        found = await Discover.discover(
            target=target,
            discovery_timeout=DISCOVERY_TIMEOUT,
            credentials=kasa_credentials(),
        )
        devices.update(found)

    if not devices:
        semaphore = asyncio.Semaphore(SCAN_CONCURRENCY)

        async def discover_host(host):
            async with semaphore:
                try:
                    return await Discover.discover_single(
                        host,
                        discovery_timeout=SCAN_TIMEOUT,
                        timeout=SCAN_TIMEOUT,
                        credentials=kasa_credentials(),
                    )
                except Exception:
                    return None

        scan_results = await asyncio.gather(
            *(discover_host(host) for host in local_scan_hosts())
        )
        for device in scan_results:
            if device is not None:
                devices[device.host] = device

    bulbs = {}

    for ip, device in devices.items():
        if not isinstance(device, IotBulb):
            await device.protocol.close()
            continue
        bulbs[ip] = device

    save_cache(bulbs.values())
    return bulbs


async def discover_cached_bulbs():
    cache = load_cache()
    hosts = []
    for entry in cache.values():
        if isinstance(entry, dict) and is_ip(str(entry.get("host", ""))):
            hosts.append(entry["host"])

    async def discover_host(host):
        try:
            device = await Discover.discover_single(
                host,
                discovery_timeout=SCAN_TIMEOUT,
                timeout=SCAN_TIMEOUT,
                credentials=kasa_credentials(),
            )
        except Exception:
            return None
        return device if isinstance(device, IotBulb) or hasattr(device, "modules") else None

    bulbs = {}
    for device in await asyncio.gather(*(discover_host(host) for host in dict.fromkeys(hosts))):
        if device is not None:
            bulbs[device.host] = device

    if bulbs:
        save_cache(bulbs.values())
    return bulbs


def targets_match_bulbs(targets, bulbs):
    selectors = set()
    for bulb in bulbs:
        selectors.update(device_selectors(bulb))

    return all(
        target in selectors or normalize_selector(target) in selectors
        for target in targets
    )


async def resolve_bulbs(targets):
    expanded_targets = expand_targets(targets)
    ip_targets = [target for target in expanded_targets if is_ip(target)]
    stable_targets = [target for target in expanded_targets if not is_ip(target)]

    bulbs_by_target = {}
    if stable_targets:
        discovered = await discover_cached_bulbs()
        if not targets_match_bulbs(stable_targets, discovered.values()):
            discovered = await discover_bulbs()
        discovered_by_selector = {}

        for bulb in discovered.values():
            for selector in device_selectors(bulb):
                discovered_by_selector[selector] = bulb

        for target in stable_targets:
            bulb = (
                discovered_by_selector.get(target)
                or discovered_by_selector.get(normalize_mac(target))
                or discovered_by_selector.get(normalize_selector(target))
            )
            if bulb is None:
                known = ", ".join(
                    sorted(
                        f"{bulb.alias} ({bulb.mac})"
                        for bulb in discovered.values()
                    )
                )
                raise SystemExit(
                    f"No discovered bulb matched '{target}'."
                    + (f" Discovered bulbs: {known}" if known else " No bulbs were discovered.")
                )
            bulbs_by_target[bulb.host] = bulb

    for ip in ip_targets:
        if ip not in bulbs_by_target:
            bulb = bulb_for_host(ip)
            await bulb.update()
            bulbs_by_target[ip] = bulb

    return list(bulbs_by_target.values())


async def control_bulb(bulb, brightness=None, temperature=None, hex_color=None, turn_off=False):
    bulb = await connect_device_for_control(bulb)
    await bulb.update()
    label = f"{bulb.alias} [{bulb.host}]"

    if turn_off: 
        await bulb.turn_off() 
        print(f"[{label}] Turned OFF") 
        return

    tasks = []

    if brightness is not None or temperature is not None or hex_color:
        light = bulb.modules["Light"]

        if brightness is not None:
            tasks.append(light.set_brightness(brightness))

        if temperature is not None:
            clamped_temp = max(2500, min(6500, temperature))
            if clamped_temp != temperature:
                print(f"[{label}] WARNING: Color temperature {temperature}K out of range (2500-6500). Clamped to {clamped_temp}K.")
            tasks.append(light.set_color_temp(clamped_temp))

        elif hex_color:
            r, g, b = hex_to_rgb(hex_color)
            hue, sat = rgb_to_hsv(r, g, b)
            tasks.append(light.set_hsv(hue, sat, brightness or light.brightness))

    if tasks:
        await asyncio.gather(*tasks)
        await bulb.turn_on()
        print(f"[{label}] Set brightness={brightness}, temperature={temperature}, color={hex_color}")
    else:
        await bulb.turn_on()
        print(f"[{label}] Turned ON")


async def control_bulb_checked(bulb, **kwargs):
    label = f"{bulb.alias or bulb.mac or bulb.device_id or 'unknown'} [{bulb.host}]"
    try:
        await control_bulb(bulb, **kwargs)
        return True
    except Exception as exc:
        print(f"[{label}] ERROR: {exc}", file=sys.stderr)
        if "challenge" in str(exc).lower() or "password" in str(exc).lower():
            print(
                "Set the exact TP-Link/Kasa account KASA_USERNAME and KASA_PASSWORD in .env.",
                file=sys.stderr,
            )
        return False
    finally:
        try:
            await bulb.protocol.close()
        except Exception:
            pass


async def main(args):
    if args.list:
        bulbs = await discover_bulbs()
        for bulb in bulbs.values():
            print(f"{bulb.alias}\t{bulb.mac}\t{bulb.device_id}\t{bulb.host}")
        return

    args.target, action = parse_actions(args.target)
    if action == "off":
        args.off = True

    bulbs = await resolve_bulbs(args.target)
    results = await asyncio.gather(*[
        control_bulb_checked(
            bulb,
            brightness=args.brightness,
            temperature=args.temperature,
            hex_color=args.color,
            turn_off=args.off
        )
        for bulb in bulbs
    ])
    if not all(results):
        raise SystemExit(1)

def cli():
    parser = argparse.ArgumentParser(
        description="Control one or more Kasa Smart Bulbs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  bulb-set --list
  bulb-set office
  bulb-set office on
  bulb-set office off
  bulb-set bedroom -b 25 -t 3000
  bulb-set office bedroom -b 60 --color ffaa00
  bulb-set office bedroom --off

targets:
  Use bulb groups from BULB_<NAME>, bulb aliases, MACs, device IDs, or IPs.
  Example group: BULB_BEDROOM="boob_light1,boob_light3"
""",
    )
    parser.add_argument(
        "target",
        nargs="*",
        help="Bulb groups, aliases, MACs, device IDs, or IPs. Groups are read from BULB_<NAME> environment variables.",
    )
    parser.add_argument("--list", action="store_true", help="List discovered bulbs and their stable identifiers")
    parser.add_argument("-b", "--brightness", type=int, help="Brightness (0-100)")
    parser.add_argument("-t", "--temperature", "--temp", dest="temperature", type=int, help="Color temperature (2500-6500 K)")
    parser.add_argument("-c", "--color", help="Hex color (e.g., ff0000 or f00)")
    parser.add_argument("--off", action="store_true", help="Turn bulb(s) off. You can also use positional 'off'.")

    args = parser.parse_args()
    targets, action = parse_actions(args.target)
    if not args.list and not targets:
        parser.error("target is required unless --list is used")
    asyncio.run(main(args))

if __name__ == "__main__":
    cli()
