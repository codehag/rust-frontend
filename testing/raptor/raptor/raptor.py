#!/usr/bin/env python

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from __future__ import absolute_import

import os
import shutil
import sys
import tarfile

import mozinfo

# need this so raptor imports work both from /raptor and via mach
here = os.path.abspath(os.path.dirname(__file__))

try:
    from mozbuild.base import MozbuildObject

    build = MozbuildObject.from_environment(cwd=here)
except ImportError:
    build = None

from mozlog import commandline
from mozprofile.cli import parse_preferences

from browsertime import BrowsertimeDesktop, BrowsertimeAndroid
from cmdline import parse_args, CHROMIUM_DISTROS
from logger.logger import RaptorLogger
from manifest import get_raptor_test_list
from signal_handler import SignalHandler
from utils import view_gecko_profile
from webextension import (
    WebExtensionFirefox,
    WebExtensionDesktopChrome,
    WebExtensionAndroid,
)

LOG = RaptorLogger(component="raptor-main")


def main(args=sys.argv[1:]):
    args = parse_args()

    args.extra_prefs = parse_preferences(args.extra_prefs or [])

    if args.enable_fission:
        args.extra_prefs.update(
            {
                "fission.autostart": True,
                "dom.serviceWorkers.parent_intercept": True,
                "browser.tabs.documentchannel": True,
            }
        )

    if args.extra_prefs and args.extra_prefs.get("fission.autostart", False):
        args.enable_fission = True

    commandline.setup_logging("raptor", args, {"tbpl": sys.stdout})

    LOG.info("raptor-start")

    if args.debug_mode:
        LOG.info("debug-mode enabled")

    LOG.info("received command line arguments: %s" % str(args))

    # if a test name specified on command line, and it exists, just run that one
    # otherwise run all available raptor tests that are found for this browser
    raptor_test_list = get_raptor_test_list(args, mozinfo.os)
    raptor_test_names = [raptor_test["name"] for raptor_test in raptor_test_list]

    # ensure we have at least one valid test to run
    if len(raptor_test_list) == 0:
        LOG.critical("this test is not targeted for {}".format(args.app))
        sys.exit(1)

    LOG.info("raptor tests scheduled to run:")
    for next_test in raptor_test_list:
        LOG.info(next_test["name"])

    if not args.browsertime:
        if args.app == "firefox":
            raptor_class = WebExtensionFirefox
        elif args.app in CHROMIUM_DISTROS:
            raptor_class = WebExtensionDesktopChrome
        else:
            raptor_class = WebExtensionAndroid
    else:

        def raptor_class(*inner_args, **inner_kwargs):
            outer_kwargs = vars(args)
            # peel off arguments that are specific to browsertime
            for key in outer_kwargs.keys():
                if key.startswith("browsertime_"):
                    value = outer_kwargs.pop(key)
                    inner_kwargs[key] = value

            if args.app == "firefox" or args.app in CHROMIUM_DISTROS:
                klass = BrowsertimeDesktop
            else:
                klass = BrowsertimeAndroid

            return klass(*inner_args, **inner_kwargs)

    raptor = raptor_class(
        args.app,
        args.binary,
        run_local=args.run_local,
        noinstall=args.noinstall,
        installerpath=args.installerpath,
        obj_path=args.obj_path,
        gecko_profile=args.gecko_profile,
        gecko_profile_interval=args.gecko_profile_interval,
        gecko_profile_entries=args.gecko_profile_entries,
        symbols_path=args.symbols_path,
        host=args.host,
        power_test=args.power_test,
        cpu_test=args.cpu_test,
        memory_test=args.memory_test,
        is_release_build=args.is_release_build,
        debug_mode=args.debug_mode,
        post_startup_delay=args.post_startup_delay,
        activity=args.activity,
        intent=args.intent,
        interrupt_handler=SignalHandler(),
        enable_webrender=args.enable_webrender,
        extra_prefs=args.extra_prefs or {},
        device_name=args.device_name,
        no_conditioned_profile=args.no_conditioned_profile,
    )

    success = raptor.run_tests(raptor_test_list, raptor_test_names)

    if not success:
        # didn't get test results; test timed out or crashed, etc. we want job to fail
        LOG.critical(
            "TEST-UNEXPECTED-FAIL: no raptor test results were found for %s"
            % ", ".join(raptor_test_names)
        )
        os.sys.exit(1)

    # if we have results but one test page timed out (i.e. one tp6 test page didn't load
    # but others did) we still dumped PERFHERDER_DATA for the successfull pages but we
    # want the overall test job to marked as a failure
    pages_that_timed_out = raptor.get_page_timeout_list()
    if len(pages_that_timed_out) > 0:
        for _page in pages_that_timed_out:
            message = [
                ("TEST-UNEXPECTED-FAIL", "test '%s'" % _page["test_name"]),
                ("timed out loading test page", _page["url"]),
            ]
            if _page.get("pending_metrics") is not None:
                message.append(("pending metrics", _page["pending_metrics"]))

            LOG.critical(
                " ".join("%s: %s" % (subject, msg) for subject, msg in message)
            )
        os.sys.exit(1)

    # if we're running browsertime in the CI, we want to zip the result dir
    if args.browsertime and not args.run_local:
        result_dir = raptor.results_handler.result_dir()
        if os.path.exists(result_dir):
            LOG.info("Creating tarball at %s" % result_dir + ".tgz")
            with tarfile.open(result_dir + ".tgz", "w:gz") as tar:
                tar.add(result_dir, arcname=os.path.basename(result_dir))
            LOG.info("Removing %s" % result_dir)
            shutil.rmtree(result_dir)

    # when running raptor locally with gecko profiling on, use the view-gecko-profile
    # tool to automatically load the latest gecko profile in profiler.firefox.com
    if args.gecko_profile and args.run_local:
        if os.environ.get("DISABLE_PROFILE_LAUNCH", "0") == "1":
            LOG.info(
                "Not launching profiler.firefox.com because DISABLE_PROFILE_LAUNCH=1"
            )
        else:
            view_gecko_profile(args.binary)


if __name__ == "__main__":
    main()
