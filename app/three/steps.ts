/**
 * The scene build as a sequence of named stages, so the loading screen can say what runs.
 *
 * A builder long enough to be worth a caption is a generator (`Steps<T>`): each `yield` names the
 * stage that starts now, and its return value is the build. `runSteps` drains one synchronously
 * (Node, the audits, `buildEnvironment`); the viewport drains `environmentSteps` itself and
 * repaints the loading screen between the stages it expects to take a while.
 *
 * Wall-clock inside such a generator is read from `buildClock()`, which leaves out the time the
 * caller spent between two `next()` calls (`excludeFromBuildClock`): `buildMs` and the stages'
 * `timing` stay what the builders cost, whoever drains them and however often they paint.
 */
export type Steps<T> = Generator<string, T, void>

/** drain a build synchronously and return what it built */
export function runSteps<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/** the stages of a nested build, renamed `<parent>/<stage>` */
export function* within<T>(parent: string, steps: Steps<T>): Steps<T> {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
    yield `${parent}/${r.value}`
  }
}

let excluded = 0

/** performance.now() less the time spent outside the builders between their stages */
export function buildClock(): number {
  return performance.now() - excluded
}

/** a driver's pause between two stages (ms), left out of every `buildClock` difference that spans it */
export function excludeFromBuildClock(ms: number) {
  excluded += ms
}
