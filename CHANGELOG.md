# [0.10.0](https://github.com/asermax/herdr-subagents/compare/v0.9.4...v0.10.0) (2026-09-20)


### Features

* clarify child closure timing as a delegation decision ([7829487](https://github.com/asermax/herdr-subagents/commit/7829487f77e94a8179011c5c2cf8f2c4235c1c8e))

## [0.9.4](https://github.com/asermax/herdr-subagents/compare/v0.9.3...v0.9.4) (2026-09-15)


### Bug Fixes

* make spawn-body delivery failures diagnosable ([b89204d](https://github.com/asermax/herdr-subagents/commit/b89204d7ecc5203eaea401027bd5fc8f481ddc35))

## [0.9.3](https://github.com/asermax/herdr-subagents/compare/v0.9.2...v0.9.3) (2026-09-14)


### Bug Fixes

* **helper:** close the watch's blind spots for child closure ([3282294](https://github.com/asermax/herdr-subagents/commit/3282294d659d0824ee7605b03298e4860e2db9e4))
* **helper:** guard the registry against concurrent helper processes ([b9c7e19](https://github.com/asermax/herdr-subagents/commit/b9c7e19a22d48ee07f23a252fbd69fa58ae30e60))

## [0.9.2](https://github.com/asermax/herdr-subagents/compare/v0.9.1...v0.9.2) (2026-09-13)


### Bug Fixes

* **helper:** treat a prompt to a working child as a delivered steer ([dc194d5](https://github.com/asermax/herdr-subagents/commit/dc194d596c039af5c9cf774bd08eb9d672d683bd))

## [0.9.1](https://github.com/asermax/herdr-subagents/compare/v0.9.0...v0.9.1) (2026-09-13)


### Bug Fixes

* **extension:** stop echoing the prompt body in tool results ([3baf6d1](https://github.com/asermax/herdr-subagents/commit/3baf6d1ace8bb475d685166b95230705b4fb5d75))

# [0.9.0](https://github.com/asermax/herdr-subagents/compare/v0.8.1...v0.9.0) (2026-09-13)


### Features

* let a prompt body come from a file ([d0023fd](https://github.com/asermax/herdr-subagents/commit/d0023fdda338a060e28e073d9e68bd93808a5b01))

## [0.8.1](https://github.com/asermax/herdr-subagents/compare/v0.8.0...v0.8.1) (2026-09-13)


### Bug Fixes

* **extension:** make the subagent tool the only surface the pi model sees ([7f82de2](https://github.com/asermax/herdr-subagents/commit/7f82de2c38c31047eeb61176a40a0dd09a87f0a6))

# [0.8.0](https://github.com/asermax/herdr-subagents/compare/v0.7.1...v0.8.0) (2026-09-13)


### Features

* let a spawn deliver its first prompt ([f36bc02](https://github.com/asermax/herdr-subagents/commit/f36bc020682204a3f3ad5039a1e49b380fcd6c5d))

## [0.7.1](https://github.com/asermax/herdr-subagents/compare/v0.7.0...v0.7.1) (2026-09-07)


### Bug Fixes

* **helper:** subscribe to the fleet before reading the registry ([11fc208](https://github.com/asermax/herdr-subagents/commit/11fc208484e8c11433752b7bd4dd9cb1e986a03e))

# [0.7.0](https://github.com/asermax/herdr-subagents/compare/v0.6.0...v0.7.0) (2026-09-07)


### Features

* let a spawn name the model its child runs on ([eef52d6](https://github.com/asermax/herdr-subagents/commit/eef52d6186859945c2a00ff965b610765874e806))

# [0.6.0](https://github.com/asermax/herdr-subagents/compare/v0.5.0...v0.6.0) (2026-08-31)


### Bug Fixes

* **helper:** reject --branch without --worktree before reaching for herdr ([54c061e](https://github.com/asermax/herdr-subagents/commit/54c061ec256d85f9f77f4ceafcc2349415fb2ee0))


### Features

* **helper:** give a child its own git worktree, and let the last one out take it ([ba0557b](https://github.com/asermax/herdr-subagents/commit/ba0557b43403dcc96e57078444b1cb6ba6201091))

# [0.5.0](https://github.com/asermax/herdr-subagents/compare/v0.4.0...v0.5.0) (2026-08-26)


### Features

* **helper:** never miss a child's wake, and hand blocked children to the human ([22b6111](https://github.com/asermax/herdr-subagents/commit/22b611101c7a77f7cbb08d87c3790188b132e315))

# [0.4.0](https://github.com/asermax/herdr-subagents/compare/v0.3.2...v0.4.0) (2026-08-06)


### Features

* **extension:** add `subagent` tool wrapping the helper on pi ([ee5ff01](https://github.com/asermax/herdr-subagents/commit/ee5ff019a02f3ca943fb0cb91a0c0e1163711818))

## [0.3.2](https://github.com/asermax/herdr-subagents/compare/v0.3.1...v0.3.2) (2026-08-06)


### Bug Fixes

* **watch:** don't emit `unknown` for a still-booting child ([149f2ea](https://github.com/asermax/herdr-subagents/commit/149f2eafb7296aabc003fa67e033aa324c5f1168))

## [0.3.1](https://github.com/asermax/herdr-subagents/compare/v0.3.0...v0.3.1) (2026-08-06)


### Bug Fixes

* **build:** make the pi helper path portable across installs ([ea11afb](https://github.com/asermax/herdr-subagents/commit/ea11afb3d78e401d577c84f740d72c56cda9fa5e))

# [0.3.0](https://github.com/asermax/herdr-subagents/compare/v0.2.1...v0.3.0) (2026-08-06)


### Features

* **helper:** drive watch from event subscriptions, not polling ([fa04f15](https://github.com/asermax/herdr-subagents/commit/fa04f1592bf670ec4811923a855420eea25845a0))

## [0.2.1](https://github.com/asermax/herdr-subagents/compare/v0.2.0...v0.2.1) (2026-08-06)


### Bug Fixes

* **claude:** bundle herdr-helper next to the skill, use $CLAUDE_PLUGIN_ROOT ([f0b8287](https://github.com/asermax/herdr-subagents/commit/f0b8287b117ae5accc1485aa427774ffbd0f3095))

# [0.2.0](https://github.com/asermax/herdr-subagents/compare/v0.1.0...v0.2.0) (2026-08-05)


### Bug Fixes

* **ci:** check references/onboarding.md in the install verification ([9f26744](https://github.com/asermax/herdr-subagents/commit/9f2674464293530a91a42663f916ad5ff531b9d6))


### Features

* **build:** ship a README in each artifact and fix the pi bin path ([9183ddb](https://github.com/asermax/herdr-subagents/commit/9183ddb55265768bffb7b1d7c5188c561cc0c413))
* **helper:** drop closed children from the widget without waking ([00bd9aa](https://github.com/asermax/herdr-subagents/commit/00bd9aa34e65a64f481e02b3d610ca3d77d1dcc9))
