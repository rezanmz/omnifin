# Changelog

## [0.5.0](https://github.com/rezanmz/omnifin/compare/v0.4.1...v0.5.0) (2026-08-01)


### Features

* **auth:** add first administrator bootstrap ([#134](https://github.com/rezanmz/omnifin/issues/134)) ([e81994b](https://github.com/rezanmz/omnifin/commit/e81994bd9569538c83598d5accdc7d113227616e))
* **release:** publish digest-pinned install bundle ([#142](https://github.com/rezanmz/omnifin/issues/142)) ([bc81308](https://github.com/rezanmz/omnifin/commit/bc813084033f7253f7e2f6ad900f3ab0b8a8a1f1)), closes [#141](https://github.com/rezanmz/omnifin/issues/141)


### Fixes

* **ci:** isolate Playwright dependency installation ([#138](https://github.com/rezanmz/omnifin/issues/138)) ([e82b416](https://github.com/rezanmz/omnifin/commit/e82b41625f0116710bbda5800749ea4a1b868796)), closes [#136](https://github.com/rezanmz/omnifin/issues/136)
* **ci:** preserve Jellyfin failure evidence ([#130](https://github.com/rezanmz/omnifin/issues/130)) ([fe16a15](https://github.com/rezanmz/omnifin/commit/fe16a1581936b9be3fec55e7f26cafdf1d7c25a2)), closes [#129](https://github.com/rezanmz/omnifin/issues/129) [#131](https://github.com/rezanmz/omnifin/issues/131)
* **ci:** retry stalled Playwright installs ([#126](https://github.com/rezanmz/omnifin/issues/126)) ([f2f45e5](https://github.com/rezanmz/omnifin/commit/f2f45e5085aed846496fa9f39b45ba4e549fc889))
* **ci:** retry transient Jellyfin container startup ([6a868c0](https://github.com/rezanmz/omnifin/commit/6a868c0dea7e30f5d2d091cb7716bf9a989b12e4)), closes [#135](https://github.com/rezanmz/omnifin/issues/135)
* **web:** stabilize modal pointer submissions ([#140](https://github.com/rezanmz/omnifin/issues/140)) ([74b3f8e](https://github.com/rezanmz/omnifin/commit/74b3f8e241a2df71e4483749694f2451234b0d09)), closes [#139](https://github.com/rezanmz/omnifin/issues/139)

## [0.4.1](https://github.com/rezanmz/omnifin/compare/v0.4.0...v0.4.1) (2026-07-31)


### Fixes

* **ui:** stabilize request completion action ([#119](https://github.com/rezanmz/omnifin/issues/119)) ([9745cdb](https://github.com/rezanmz/omnifin/commit/9745cdbd9b65666952ca4075a56b1dddd5c344d1)), closes [#118](https://github.com/rezanmz/omnifin/issues/118)


### Continuous integration

* **release:** rehearse upgrades and rollback ([#116](https://github.com/rezanmz/omnifin/issues/116)) ([f12bb4a](https://github.com/rezanmz/omnifin/commit/f12bb4a1461a1bfd0d65d7281ef16e9815643532)), closes [#113](https://github.com/rezanmz/omnifin/issues/113)
* run disposable compatibility canary ([#121](https://github.com/rezanmz/omnifin/issues/121)) ([98ad89b](https://github.com/rezanmz/omnifin/commit/98ad89b1dcb0421dc5761d3d896e3f634801b8c9)), closes [#117](https://github.com/rezanmz/omnifin/issues/117)

## [0.4.0](https://github.com/rezanmz/omnifin/compare/v0.3.0...v0.4.0) (2026-07-31)


### Features

* **gateway:** stream live health snapshots ([#110](https://github.com/rezanmz/omnifin/issues/110)) ([6585984](https://github.com/rezanmz/omnifin/commit/658598429affca43948b551046a7d3e4f2fa0a4b)), closes [#109](https://github.com/rezanmz/omnifin/issues/109)
* **ui:** add permission-aware command palette ([#107](https://github.com/rezanmz/omnifin/issues/107)) ([188abcf](https://github.com/rezanmz/omnifin/commit/188abcfedf972e4c0f27d2ec0e3adddbeadd9936))


### Fixes

* **auth:** read mapped sessions from browser ([#102](https://github.com/rezanmz/omnifin/issues/102)) ([16e10eb](https://github.com/rezanmz/omnifin/commit/16e10eb4fb9b6aeaaa55ce8f99b318e3c416adb4))
* **ui:** make system pulse actionable ([#108](https://github.com/rezanmz/omnifin/issues/108)) ([e98a8be](https://github.com/rezanmz/omnifin/commit/e98a8be01a1d3730b7eb7baec9c3bc5da56559fc)), closes [#105](https://github.com/rezanmz/omnifin/issues/105)
* **ui:** stabilize acquisition recovery action ([#104](https://github.com/rezanmz/omnifin/issues/104)) ([ece59a2](https://github.com/rezanmz/omnifin/commit/ece59a279a59648acd05a9b2372b5c92bddbf609))

## [0.3.0](https://github.com/rezanmz/omnifin/compare/v0.2.0...v0.3.0) (2026-07-31)


### Features

* **ci:** verify Bazarr subtitle mutation ([#83](https://github.com/rezanmz/omnifin/issues/83)) ([83de76c](https://github.com/rezanmz/omnifin/commit/83de76c6f28018bfd9e8d2d871ec0bc5d103d379))
* **ci:** verify isolated Seerr requests ([#87](https://github.com/rezanmz/omnifin/issues/87)) ([21cd3ab](https://github.com/rezanmz/omnifin/commit/21cd3ab17bbc6139ffe27832c19db4d8bb134e83))
* **ci:** verify safe connector mutations ([#78](https://github.com/rezanmz/omnifin/issues/78)) ([5858692](https://github.com/rezanmz/omnifin/commit/585869219a1dffb53daf0799b8d380a5c0cb241d))
* **connectors:** derive Jellyfin artwork accents ([#100](https://github.com/rezanmz/omnifin/issues/100)) ([238c6b2](https://github.com/rezanmz/omnifin/commit/238c6b2fcc6ded1fcb4b3d586c95bcefe9906dd4)), closes [#99](https://github.com/rezanmz/omnifin/issues/99)


### Fixes

* **auth:** await mapped session convergence ([#94](https://github.com/rezanmz/omnifin/issues/94)) ([9213029](https://github.com/rezanmz/omnifin/commit/9213029fceaf9a8977b71508263f71e978349954))
* **ci:** harden connector fixture startup ([#76](https://github.com/rezanmz/omnifin/issues/76)) ([16eea89](https://github.com/rezanmz/omnifin/commit/16eea89a240e7c18a5f497313c2483d7ca13895b))
* **connectors:** bound Jellyfin restart readiness ([#96](https://github.com/rezanmz/omnifin/issues/96)) ([dad3be6](https://github.com/rezanmz/omnifin/commit/dad3be67d19eaddfa58dc4096ae2c3e8c80dd702))
* **ui:** make lazy actions hydration-safe ([#81](https://github.com/rezanmz/omnifin/issues/81)) ([fbc1f21](https://github.com/rezanmz/omnifin/commit/fbc1f21ccc871d840230435973bfbee43ef53862))
* **ui:** polish signed-out dashboard boundaries ([#98](https://github.com/rezanmz/omnifin/issues/98)) ([182780d](https://github.com/rezanmz/omnifin/commit/182780d49e114756e2dea71c11439caf391d38d7))
* **ui:** stabilize acquisition monitoring action ([#95](https://github.com/rezanmz/omnifin/issues/95)) ([d3bfd8e](https://github.com/rezanmz/omnifin/commit/d3bfd8e623af726e4edd6240c0d0c089a19e3da0))

## [0.2.0](https://github.com/rezanmz/omnifin/compare/v0.1.0...v0.2.0) (2026-07-30)


### Features

* add live discovery dashboard rails ([f7d4712](https://github.com/rezanmz/omnifin/commit/f7d47125f1647c7c741fad88a71a9bf56f59b6d2)), closes [#64](https://github.com/rezanmz/omnifin/issues/64)
* **auth:** add guarded role mapping updates ([#67](https://github.com/rezanmz/omnifin/issues/67)) ([52e8880](https://github.com/rezanmz/omnifin/commit/52e8880a134849d0c70781a118428590af496899)), closes [#66](https://github.com/rezanmz/omnifin/issues/66)
* **auth:** add user access controls ([#57](https://github.com/rezanmz/omnifin/issues/57)) ([882116b](https://github.com/rezanmz/omnifin/commit/882116b919a7380c68786e2d725c2bb6a50f2db4)), closes [#55](https://github.com/rezanmz/omnifin/issues/55)
* **gateway:** stream live provenance updates ([#63](https://github.com/rezanmz/omnifin/issues/63)) ([9db2f87](https://github.com/rezanmz/omnifin/commit/9db2f87f1120d69b12ec5ccaa8d361d2ef35134e)), closes [#62](https://github.com/rezanmz/omnifin/issues/62)


### Fixes

* **ci:** allow draft release validation ([#54](https://github.com/rezanmz/omnifin/issues/54)) ([9e5f06d](https://github.com/rezanmz/omnifin/commit/9e5f06d11bd3576ddaf0945dad8c2c9b8c07eb56)), closes [#53](https://github.com/rezanmz/omnifin/issues/53)
* **ci:** preserve release chain after optional gates ([#59](https://github.com/rezanmz/omnifin/issues/59)) ([e8b3b5f](https://github.com/rezanmz/omnifin/commit/e8b3b5fd09973bc9dd9b8ec448186eb985faded2)), closes [#58](https://github.com/rezanmz/omnifin/issues/58)
* **ci:** stabilize gateway memory budget ([#71](https://github.com/rezanmz/omnifin/issues/71)) ([8c1c9e2](https://github.com/rezanmz/omnifin/commit/8c1c9e25dd5756d60e84034a13ea5112ba9ee37b)), closes [#70](https://github.com/rezanmz/omnifin/issues/70)

## 0.1.0 (2026-07-29)


### Features

* add acquisition provenance timeline ([#14](https://github.com/rezanmz/omnifin/issues/14)) ([d5be50f](https://github.com/rezanmz/omnifin/commit/d5be50f67c20b96ace05ec32abcd1299a83ae021))
* add download queue priority controls ([#45](https://github.com/rezanmz/omnifin/issues/45)) ([e0aa0fd](https://github.com/rezanmz/omnifin/commit/e0aa0fd5a92c8b92b8b2abc7ba181c7628d87da8))
* add exact download queue controls ([#40](https://github.com/rezanmz/omnifin/issues/40)) ([739f0bb](https://github.com/rezanmz/omnifin/commit/739f0bb286e822ef68f7a04d6e289b0b25ad1a61))
* add exact-target acquisition recovery ([#16](https://github.com/rezanmz/omnifin/issues/16)) ([814d80a](https://github.com/rezanmz/omnifin/commit/814d80a11d4db62f5bd69725e16f6e75ed00b156))
* add exact-title acquisition monitoring ([#39](https://github.com/rezanmz/omnifin/issues/39)) ([ee469b9](https://github.com/rezanmz/omnifin/commit/ee469b98cf7db80f153a2a12383414e185f896a1))
* add private system health telemetry ([#37](https://github.com/rezanmz/omnifin/issues/37)) ([a296ae7](https://github.com/rezanmz/omnifin/commit/a296ae788699483835aafdb732ded471d782979e))
* add Prowlarr indexer intelligence ([#17](https://github.com/rezanmz/omnifin/issues/17)) ([ab886e5](https://github.com/rezanmz/omnifin/commit/ab886e5b49504c00457c59c4c743a1e55ff1ef7d))
* add safe download queue removal ([#42](https://github.com/rezanmz/omnifin/issues/42)) ([ae61740](https://github.com/rezanmz/omnifin/commit/ae6174092a680f5954909edccfe161c87f898e07))
* add secure playback issue reporting ([2329080](https://github.com/rezanmz/omnifin/commit/2329080e3fb59384b5acc5e1a97e4dd7b52fdbec))
* **auth:** establish secure identity foundation ([#6](https://github.com/rezanmz/omnifin/issues/6)) ([24d0910](https://github.com/rezanmz/omnifin/commit/24d091063ffb056a172e0ef77b98c9ce887613d8))
* **connectors:** add secure Bazarr subtitle operations ([#22](https://github.com/rezanmz/omnifin/issues/22)) ([0621124](https://github.com/rezanmz/omnifin/commit/062112439695db0270e94adb69eaa5cb3e9d1da8))
* **db:** add verified backup and restore ([#34](https://github.com/rezanmz/omnifin/issues/34)) ([76bb9ac](https://github.com/rezanmz/omnifin/commit/76bb9ac706e2667764458ce15093003c67ee31c3))
* **discovery:** add normalized media details ([#36](https://github.com/rezanmz/omnifin/issues/36)) ([347c6d1](https://github.com/rezanmz/omnifin/commit/347c6d1e12f8145c789d9685dbacde7d2a153303))
* **discovery:** add unified Seerr search ([#8](https://github.com/rezanmz/omnifin/issues/8)) ([9e4629c](https://github.com/rezanmz/omnifin/commit/9e4629cb5c40947c4a7efc6ba1bf57328faafdae))
* establish public project foundation ([#1](https://github.com/rezanmz/omnifin/issues/1)) ([60feeb2](https://github.com/rezanmz/omnifin/commit/60feeb250f80f9ae076f46169e36c8714dd9c675))
* **gateway:** add media intelligence ([8ba0eec](https://github.com/rezanmz/omnifin/commit/8ba0eecbb8e774fed99188d6a494ea144f28d069))
* **gateway:** add secure Seerr request workflow ([7f342cd](https://github.com/rezanmz/omnifin/commit/7f342cdc7fa9211e0f7da50fa376f01197b29538))
* **gateway:** add secure Seerr routing ([0c5b01c](https://github.com/rezanmz/omnifin/commit/0c5b01c3c21c6ef76327cff32e07a8213992d3e3))
* refine liquid glass material ([#15](https://github.com/rezanmz/omnifin/issues/15)) ([de2c6f4](https://github.com/rezanmz/omnifin/commit/de2c6f43354725a07bd1bb4fc47b6d77b3bfc133))
* stream live download queue updates ([#46](https://github.com/rezanmz/omnifin/issues/46)) ([ac0af42](https://github.com/rezanmz/omnifin/commit/ac0af42fcdbe8f6d432be53f788d464cf7404fff))
* **ui:** add manual release workbench ([27c2a4c](https://github.com/rezanmz/omnifin/commit/27c2a4c007e6e49986f139bfbec98616bafdaded))
* **ui:** build service control room ([#7](https://github.com/rezanmz/omnifin/issues/7)) ([c339b8b](https://github.com/rezanmz/omnifin/commit/c339b8b7f1bb36be482d7bda29d62ac7b7edb267))
* **web:** add acquisition calendar ([#21](https://github.com/rezanmz/omnifin/issues/21)) ([4454fcf](https://github.com/rezanmz/omnifin/commit/4454fcf7ef6799ba224a70a050146108bcd7e529))
* **web:** add Jellyfin Library Care ([#24](https://github.com/rezanmz/omnifin/issues/24)) ([5d8dd0f](https://github.com/rezanmz/omnifin/commit/5d8dd0f9cbbc2c1f79db18d7c0f35813c9305cf9))
* **web:** add live download queues ([#20](https://github.com/rezanmz/omnifin/issues/20)) ([13a7446](https://github.com/rezanmz/omnifin/commit/13a74464aedaad0991dd123b26746c2b1b434320))
* **web:** add media issue lifecycle ([#35](https://github.com/rezanmz/omnifin/issues/35)) ([62fde4a](https://github.com/rezanmz/omnifin/commit/62fde4a49eacdb47a47211d41bd16035f684696e))
* **web:** add private Continue Watching ([#23](https://github.com/rezanmz/omnifin/issues/23)) ([015f638](https://github.com/rezanmz/omnifin/commit/015f638d0c4ad687ba9e9dd1c58f79b2054174a9))
* **web:** add secure Jellyfin playback ([#26](https://github.com/rezanmz/omnifin/issues/26)) ([d0f3b21](https://github.com/rezanmz/omnifin/commit/d0f3b21ed50ffe45074da6da9fc25d4d53df691b))
* **web:** add Seerr request review ([#32](https://github.com/rezanmz/omnifin/issues/32)) ([56e5a3d](https://github.com/rezanmz/omnifin/commit/56e5a3d7f96cd9b0cf267502fcacc5c624c1e6c0))
* **web:** introduce adaptive liquid glass themes ([043f29f](https://github.com/rezanmz/omnifin/commit/043f29f25928fbaa3e6242ac05241fbb54b185ea))


### Fixes

* **ci:** exclude generated changelog from formatting ([#38](https://github.com/rezanmz/omnifin/issues/38)) ([998c537](https://github.com/rezanmz/omnifin/commit/998c53755b958e24ee5980efd079938265011f21))
* **ci:** harden protected release gates ([#28](https://github.com/rezanmz/omnifin/issues/28)) ([14d3f4c](https://github.com/rezanmz/omnifin/commit/14d3f4c0b1882345f7d0ba5e87323dfd26d83e86))
* **release:** preserve pre-1.0 versioning ([#27](https://github.com/rezanmz/omnifin/issues/27)) ([0622847](https://github.com/rezanmz/omnifin/commit/06228479253fe6a100111f84e6b93dbb911c3e7b))
* **ui:** deepen liquid glass material ([842a1d2](https://github.com/rezanmz/omnifin/commit/842a1d25f8b8e0fb2090591272b80aa9fdd0c27e))


### Continuous integration

* add generated playback fixture gate ([#31](https://github.com/rezanmz/omnifin/issues/31)) ([a956372](https://github.com/rezanmz/omnifin/commit/a9563721f092f6d5910ea0d2bc1b949fd55c463e))
* enforce gateway load budgets ([#30](https://github.com/rezanmz/omnifin/issues/30)) ([bfc5bbd](https://github.com/rezanmz/omnifin/commit/bfc5bbdb6a0e392cebe69901ce529609e10ff79d))
* reuse Trivy database cache ([#41](https://github.com/rezanmz/omnifin/issues/41)) ([67acb98](https://github.com/rezanmz/omnifin/commit/67acb98887480f91b7d861f6acc9a7293d5fc8d7))

## Changelog

All notable changes to Omnifin will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/) and uses Conventional
Commit titles to prepare reviewed release pull requests.

## Unreleased

- Establish the initial public-project foundation.
