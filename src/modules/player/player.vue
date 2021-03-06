<template>
  <div
    class="player"
    tabindex="0"
    @keydown.exact="onKeyDown"
    @keydown.exact.escape.prevent="isFullscreen ? toggleFullscreen() : null"
    @wheel.capture="onScroll"
  >
    <transition name="fade">
      <video
        preload
        :muted="muted"
        :autoplay="shouldAutoPlay"
        :poster="episode && episode.thumbnail"
        ref="player"
        :class="{ ended }"
      >
        <track v-if="subtitleUrl" :src="subtitleUrl" default />
      </video>
    </transition>

    <transition name="fade">
      <icon
        v-if="!initiated && loaded"
        class="uninitiated-icon"
        :icon="playCircleSvg"
      />
    </transition>

    <transition name="fade">
      <span v-if="loading || loadingVideo" class="loading-spinner">
        <icon :icon="loadingSvg" />
      </span>
    </transition>

    <controls
      v-if="anime && episode && levels"
      :episode="episode"
      :nextEpisode="nextEpisode"
      :anime="anime"
      :listEntry="anime.listEntry"
      :loading="loading || loadingVideo"
      :paused="paused"
      :isPlayerMaximized="isPlayerMaximized"
      :muted="muted"
      :volume="volume"
      :progressPercentage="progressPercentage"
      :progressInSeconds="progressInSeconds"
      :loadedPercentage="loadedPercentage"
      :speed="speed"
      :quality="levels[quality]"
      :levels="levels"
      :onSetTime="onSetTime"
      :onSetVolume="onSetVolume"
      :onToggleMute="onToggleMute"
      :onChangeSpeed="onChangeSpeed"
      :onChangeQuality="onChangeQuality"
      :play="play"
      :pause="pause"
      :setProgress="setProgress"
      :closePlayer="closePlayer"
    />

    <next-episode-overlay
      v-if="ended && nextEpisode"
      :nextEpisode="nextEpisode"
      :episodesInAnime="anime.episodes"
      :progress="listEntry.progress"
      :isPlayerMaximized="isPlayerMaximized"
      :shouldAutoPlay="shouldAutoPlay"
    />

    <end-of-season-overlay
      v-if="ended && !nextEpisode"
      :listEntry="listEntry"
      :sequels="sequels"
      :episodeNumber="episode.episodeNumber"
      :episodesInAnime="anime.episodes"
      :nextAiringEpisode="anime.nextAiringEpisode"
      :isPlayerMaximized="isPlayerMaximized"
    />
  </div>
</template>

<script lang="ts">
import { ipcRenderer } from 'electron'
import { Component, Prop, Vue, Watch } from 'vue-property-decorator'
import Hls from 'hls.js'
import { oc } from 'ts-optchain'

import { mdiLoading, mdiPlayCircle } from '@mdi/js'

import {
  EpisodeListEpisodes,
  MediaRelation,
  PlayerAnimeAnime,
  PlayerAnimeTitle,
  Provider,
} from '@/graphql/types'

import { Required } from '@/decorators'
import { Crunchyroll } from '@/lib/crunchyroll'
import {
  getIsFullscreen,
  PlayerData,
  sendErrorToast,
  setCurrentEpisode,
  toggleFullscreen,
} from '@/state/app'
import { getAnilistUsername } from '@/state/auth'
import { getKeydownHandler, KeybindingAction } from '@/state/settings'
import { DISCORD_PAUSE_WATCHING, DISCORD_SET_WATCHING } from '@/messages'
import { Levels, Stream } from '@/types'
import { capitalize, clamp, getRelations, lastItem } from '@/utils'

import Icon from '@/common/components/icon.vue'
import Controls from './controls.vue'
import NextEpisodeOverlay from './next-episode-overlay.vue'
import EndOfSeasonOverlay from './end-of-season-overlay.vue'
import { Hidive, HidiveResponseCode } from '@/lib/hidive'

const QUALITY_LOCALSTORAGE_KEY = 'quality_v2'
localStorage.removeItem('quality')

@Component({
  components: { Controls, EndOfSeasonOverlay, Icon, NextEpisodeOverlay },
})
export default class Player extends Vue {
  @Prop(Object) public episode!: EpisodeListEpisodes | null
  @Prop(Object) public nextEpisode!: EpisodeListEpisodes | null
  @Prop(Object) public anime!: PlayerAnimeAnime | null
  @Required(Object) public playerData!: PlayerData
  @Prop(Boolean) public loading!: boolean | null
  @Prop(Boolean) public shouldAutoPlay!: boolean | null
  @Prop(Boolean) public getShouldAutoMarkWatched?: boolean
  @Required(Function) public setProgress!: (p: number) => any

  public streamUrl: string | null = null
  public subtitleUrl: string | null = null
  public levels: Levels | null = null

  public initiated = !!this.shouldAutoPlay
  public ended = false
  // Gotten to the 'soft end' - e.g. 80% of the way
  public softEnded = false
  public loaded = false
  public loadingVideo = false
  public paused = true
  public muted = localStorage.getItem('muted') === 'true'
  public volume = Number(localStorage.getItem('volume') || 70)
  public speed = Number(localStorage.getItem('speed') || 1)
  public quality: string =
    localStorage.getItem(QUALITY_LOCALSTORAGE_KEY) || '1080'
  public progressPercentage = 0
  public progressInSeconds = 0
  public playhead = 0
  public loadedSeconds = 0
  public loadedPercentage = 0

  private lastScrobble = 0
  private lastHeartbeat = 0

  public hls = new Hls()

  // Volume
  private gainNode: GainNode | null = null

  public playCircleSvg = mdiPlayCircle
  public loadingSvg = mdiLoading

  public $refs!: {
    player: HTMLVideoElement
  }

  public get isPlayerMaximized() {
    return ['/player-big', '/player-full'].includes(this.$route.path)
  }

  private get actionFunctionMap() {
    return {
      [KeybindingAction.PAUSE]: () => this.pause(),
      [KeybindingAction.PLAY]: () => this.pause(),
      [KeybindingAction.PAUSE_PLAY]: () =>
        this.paused ? this.play() : this.pause(),
      [KeybindingAction.SKIP_BACK]: () => this.skipBySeconds(-5),
      [KeybindingAction.SKIP_FORWARD]: () => this.skipBySeconds(5),
      [KeybindingAction.VOLUME_DOWN]: () => this.increaseVolume(-10),
      [KeybindingAction.VOLUME_UP]: () => this.increaseVolume(10),
      [KeybindingAction.TOGGLE_MUTED]: () => this.onToggleMute(),
      [KeybindingAction.TOGGLE_FULLSCREEN]: () => this.toggleFullscreen(),
    }
  }

  private get keyDownHandler() {
    return getKeydownHandler(this.$store)(this.actionFunctionMap)
  }

  public get isFullscreen() {
    return getIsFullscreen(this.$store)
  }

  public get username() {
    return getAnilistUsername(this.$store)
  }

  public get listEntry() {
    return oc(this.anime).mediaListEntry(null)
  }

  public get sequels() {
    return getRelations(this, MediaRelation.Sequel)
  }

  public mounted() {
    this.onNewEpisode()

    const audioContext = new AudioContext()
    this.gainNode = audioContext.createGain()
    this.gainNode.gain.value = this.volume / 100

    audioContext
      .createMediaElementSource(this.$refs.player)
      .connect(this.gainNode)

    this.gainNode.connect(audioContext.destination)
  }

  public beforeDestroy() {
    this.fadeOutVolume()

    setTimeout(() => this.hls.destroy(), 500)
  }

  public closePlayer() {
    setCurrentEpisode(this.$store, null)

    if (this.isFullscreen) {
      this.toggleFullscreen()
    }

    // Toggle fullscreen already goes back so we only do it on big player, not full
    if (this.$route.path === '/player-big') {
      this.$router.back()
    }
  }

  private async fetchStream(provider: Provider, id: string): Promise<Stream> {
    if ([Provider.Crunchyroll, Provider.CrunchyrollManual].includes(provider)) {
      return Crunchyroll.fetchStream(id)
    }

    if (provider === Provider.Hidive) {
      try {
        return await Hidive.fetchStream(id)
      } catch (err) {
        if (err.message === HidiveResponseCode.RegionRestricted) {
          this.closePlayer()
          throw new Error('This show is not available in your country.')
        }

        throw new Error(err)
      }
    }

    return null as any
  }

  @Watch('episode.id')
  public async onNewEpisode() {
    if (!this.episode) return

    this.pause()

    try {
      const stream = await this.fetchStream(
        this.episode.provider,
        this.episode.id,
      )

      if (!stream) {
        throw new Error(
          `Did not receive stream data from ${capitalize(
            this.episode.provider,
          )}.`,
        )
      }

      this.streamUrl = stream.url
      this.subtitleUrl = stream.subtitles

      this.playhead = stream.progress || 0
    } catch (e) {
      return sendErrorToast(this.$store, e.message)
    }

    if (!this.streamUrl) return

    this.progressInSeconds = 0
    this.progressPercentage = 0
    this.ended = false
    this.softEnded = false
    this.initiated = !!this.shouldAutoPlay
    this.paused = true
    this.loadingVideo = true
    this.loaded = false

    const hls = new Hls()

    hls.loadSource(this.streamUrl)
    hls.attachMedia(this.$refs.player)

    this.hls = hls

    this.registerEvents()
  }

  public registerEvents() {
    if (!this.$refs.player || !this.episode) return

    this.hls.on('hlsManifestParsed', (_event, data) => {
      let i = 0
      const qualities = (data.levels as any).reduce(
        (map: any, level: Level) => {
          map[level.height.toString()] = i
          i++

          return map
        },
        {} as any,
      ) as Levels

      this.levels = qualities

      if (this.levels[this.quality] == null) {
        const newQuality = lastItem(Object.keys(this.levels)) as string

        localStorage.setItem(QUALITY_LOCALSTORAGE_KEY, newQuality)
        this.quality = newQuality
      }

      this.hls.loadLevel = this.levels[this.quality]
    })

    this.hls.on('hlsMediaAttached', () => {
      this.$refs.player.currentTime =
        this.playhead < (this.episode as EpisodeListEpisodes).duration * 0.8
          ? this.playhead
          : 0
    })

    this.$refs.player.onplay = () => {
      this.paused = false

      this.setDiscordState('watching')
    }
    this.$refs.player.onpause = () => {
      this.paused = true

      this.setDiscordState('paused')
    }
    this.$refs.player.oncanplay = () => {
      this.loadingVideo = false
      this.loaded = true
    }
    this.$refs.player.onwaiting = () => {
      this.loadingVideo = true
    }

    this.$refs.player.onprogress = this.onLoadedProgress
    this.$refs.player.ontimeupdate = this.onTimeUpdate
    this.$refs.player.addEventListener('ended', this.onEnded)
  }

  public onLoadedProgress(e: Event) {
    if (!this.episode) return

    const element = e.target as HTMLVideoElement
    this.loadedSeconds = element.buffered.end(0)
    this.loadedPercentage = this.loadedSeconds / this.episode.duration
  }

  public onTimeUpdate(e: Event) {
    if (!this.episode) return

    const element = e.target as HTMLVideoElement

    if (this.ended) {
      this.ended = false
    }

    this.progressInSeconds = Math.round(element.currentTime)
    this.progressPercentage = element.currentTime / this.episode.duration

    if (
      this.progressInSeconds % 10 === 0 &&
      this.lastScrobble < this.progressInSeconds
    ) {
      this.lastScrobble = this.progressInSeconds

      if (this.playerData.provider === Provider.Crunchyroll) {
        Crunchyroll.setProgressOfEpisode(
          Number(this.episode.id),
          this.progressInSeconds,
        )
      }
    }

    if (
      this.progressInSeconds % 60 === 0 &&
      this.lastHeartbeat < this.progressInSeconds
    ) {
      this.lastHeartbeat = this.progressInSeconds
    }

    if (!this.softEnded && this.progressPercentage >= 0.8) {
      this.softEnded = true
      this.lastScrobble = this.episode.duration

      if (this.playerData.provider === Provider.Crunchyroll) {
        Crunchyroll.setProgressOfEpisode(
          Number(this.episode.id),
          this.episode.duration,
        )
      }

      this.updateProgressIfNecessary()
    }
  }

  public onEnded() {
    this.ended = true
    this.softEnded = true

    this.updateProgressIfNecessary()
  }

  public onSetTime(value: number) {
    this.lastHeartbeat = this.progressInSeconds - 30

    this.setDiscordState('watching')

    this.$refs.player.currentTime = value
  }

  public onSetVolume(e: Event) {
    if (!this.gainNode) return

    const element = e.target as HTMLInputElement

    const value = clamp(+Number(element.value).toFixed(2), 0, 200)

    this.volume = value
    localStorage.setItem('volume', value.toString())

    this.gainNode.gain.value = value / 100
  }

  public onToggleMute() {
    this.muted = !this.muted

    localStorage.setItem('muted', this.muted.toString())
  }

  public onChangeSpeed(e: Event) {
    const { value } = e.target as HTMLSelectElement

    this.speed = Number(value)
    this.$refs.player.playbackRate = this.speed
  }

  public onChangeQuality(quality: string) {
    this.quality = quality
    this.hls.currentLevel = this.levels![quality]
    localStorage.setItem(QUALITY_LOCALSTORAGE_KEY, quality)
  }

  public onKeyDown(e: KeyboardEvent) {
    return this.keyDownHandler(e.key)
  }

  public onScroll(e: WheelEvent) {
    const direction = Math.sign(-e.deltaY)

    this.increaseVolume(direction * 10)
  }

  public play() {
    if (!this.paused) return

    if (!this.initiated) this.initiated = true

    this.$refs.player.play()
  }

  public pause() {
    if (this.paused) return

    this.$refs.player.pause()
  }

  public increaseVolume(n: number) {
    this.onSetVolume({
      target: {
        value: clamp(this.volume + n, 0, 200),
      },
    } as any)
  }

  public fadeOutVolume() {
    const interval = window.setInterval(() => {
      if (!this.gainNode) return

      if (this.gainNode.gain.value <= 0) {
        return clearInterval(interval)
      }

      this.gainNode.gain.value = clamp(this.gainNode.gain.value - 0.05, 0, 2)
    }, 10)
  }

  public skipBySeconds(n: number) {
    this.onSetTime(this.$refs.player.currentTime + n)
  }

  public toggleFullscreen() {
    toggleFullscreen(this.$store)
  }

  public updateProgressIfNecessary() {
    if (!this.episode) return

    if (
      !this.listEntry ||
      !this.getShouldAutoMarkWatched ||
      (this.listEntry.progress as number) >= this.episode.episodeNumber
    ) {
      return
    }

    this.setProgress(this.episode.episodeNumber)
  }

  private setDiscordState(state: 'watching' | 'paused') {
    if (!this.episode || !this.anime) return

    ipcRenderer.send(
      state === 'watching' ? DISCORD_SET_WATCHING : DISCORD_PAUSE_WATCHING,
      {
        animeName: (this.anime.title as PlayerAnimeTitle).userPreferred,
        episode: this.episode.episodeNumber,
        totalEpisodes: this.anime.episodes,
        progress: this.progressInSeconds,
        username: this.username,
      },
    )
  }
}
</script>

<style scoped lang="scss">
@import '../../colors';

@keyframes spin {
  from {
    transform: rotateZ(0deg);
  }
  to {
    transform: rotateZ(360deg);
  }
}

.player {
  position: relative;
  width: 100%;
  height: 100%;
  box-shadow: $shadow;
  overflow: hidden;

  & > video {
    background: #050505;
    width: 100%;
    height: 100%;
    transition: filter 1s;

    & > track {
      pointer-events: none;
    }

    &::cue {
      background: none;
      font-family: 'Lato', sans-serif;
      text-shadow: $outline;
      font-weight: bold;

      &:nth-child(odd) {
        color: yellow;
      }
    }

    &.ended {
      filter: blur(10px);
    }
  }

  & > .uninitiated-icon {
    position: absolute;
    top: 50%;
    left: 50%;
    height: 40%;
    fill: $white;
    filter: drop-shadow(1px 2px 3px black);
    transform: translate(-50%, -50%);
    z-index: 1;
    pointer-events: none;
  }

  & > .loading-spinner {
    position: absolute;
    top: 50%;
    left: 50%;
    height: 40%;
    pointer-events: none;
    fill: $white;
    filter: drop-shadow(1px 2px 3px black);
    transform: translate(-50%, -50%);

    & > .icon {
      height: 100%;
      width: 100%;
      animation: spin 1s linear;
      animation-iteration-count: infinite;
    }
  }
}
</style>
