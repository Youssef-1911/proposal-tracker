import argparse
import sys

from ..settings import SettingsError, load_settings
from . import SeedRefused, mark_demo, reset_demo, seed_demo


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.seed", description="Development-only demo data.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("mark-demo", help="mark an empty, migrated development database as a demo database")
    sub.add_parser("demo", help="load the demo data into an empty demo database")
    reset = sub.add_parser("reset-demo", help="rebuild a demo database from scratch")
    reset.add_argument("--yes", action="store_true", help="confirm that all demo data will be deleted")
    args = parser.parse_args(argv)

    try:
        settings = load_settings()
        if args.command == "mark-demo":
            print(mark_demo(settings))
        elif args.command == "demo":
            result = seed_demo(settings)
            print(f"Seeded demo data: {result['users']} users, {result['clients']} clients, "
                  f"{result['opportunities']} opportunities, {result['requests']} proposal requests.")
        else:
            result = reset_demo(settings, confirm=args.yes)
            print(f"Demo database rebuilt: {result['users']} users, {result['clients']} clients, "
                  f"{result['opportunities']} opportunities, {result['requests']} proposal requests.")
    except (SeedRefused, SettingsError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
