import superagent from 'superagent/dist/superagent'
import Bottleneck from 'bottleneck'
import { OptionsV2, parseString as _parseString } from 'xml2js'
import { oc } from 'ts-optchain'

import { getConfig } from '@/config'
import { delay, isNil, RequestResponse, responseIsError, T } from '@/utils'
import { parseBooleans, parseNumbers, stripPrefix } from 'xml2js/lib/processors'
import { Crunchyroll } from '@/lib/crunchyroll'

interface XmlTitle {
  _: string
  lang: 'ja' | 'en' | 'x-jat'
}

interface XmlResource {
  type: number
  externalentity: {
    identifier: [number, string]
  }
}

enum EpisodeType {
  UNKNOWN,
  EPISODE,
  UNKNOWN2,
  OPENING_OR_ENDING,
}

interface XmlEpisode {
  id: number
  update: string
  epno: {
    _: number
    type: EpisodeType
  }
  length: number
  airdate: string
  title: XmlTitle[]
  summary: string
  resources?: {
    resource: XmlResource | XmlResource[]
  }
}

interface Relation {
  anilist: number | null
  anidb: number | null
  myanimelist: number | null
  kitsu: number | null
}

interface RelationError {
  code: 400 | 404 | 500
  type: string
  messages: string[]
}

const parseString = async (xml: string, options: OptionsV2): Promise<any> =>
  new Promise((resolve, reject) => {
    _parseString(xml, options, (err, result) => {
      if (err) return reject(err)

      resolve(result)
    })
  })

const isXMLError = async (response: RequestResponse): Promise<boolean> => {
  if (responseIsError(response)) return true

  const xmlBody = await parseString(response.text, {})

  return oc(xmlBody).error() != null
}

const getIdentifier = (ep: XmlEpisode) => {
  if (ep.resources == null) return null

  if (Array.isArray(ep.resources.resource)) {
    const correctType = ep.resources.resource.find(
      resource => resource.type === 28,
    )
    if (correctType == null) return null

    return correctType.externalentity.identifier[0]
  }

  return ep.resources.resource.externalentity.identifier[0]
}

const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 2250,
})

const query = {
  client: getConfig('ANIDB_CLIENT'),
  clientver: getConfig('ANIDB_CLIENTVER'),
  protover: 1,
}

export class AniDB {
  public static async getEpisodesForAnime(id: number) {
    let anidbId

    try {
      anidbId = await AniDB.getId(id)
    } catch (e) {
      anidbId = null
    }

    if (isNil(anidbId)) return null

    const mediaId = await AniDB.getFirstEpisodeCrunchyrollId(anidbId)
    if (isNil(mediaId)) return null

    return Crunchyroll.fetchSeasonFromEpisode(id, mediaId.toString())
  }

  private static async getFirstEpisodeCrunchyrollId(anidbId: number) {
    const request = () =>
      superagent
        .get('http://api.anidb.net:9001/httpapi')
        .query({
          ...query,
          request: 'anime',
          aid: anidbId,
        })
        .ok(T)

    // When developing we lose the rate limiting between refreshes, leading to temporary bans
    if (process.env.NODE_ENV === 'development') {
      await delay(2000)
    }

    const response = (await limiter.schedule(() =>
      request(),
    )) as RequestResponse

    if (isXMLError(response)) {
      return null
    }

    const data: any = await parseString(response.text, {
      normalize: true,
      explicitRoot: false,
      explicitArray: false,
      mergeAttrs: true,
      attrNameProcessors: [stripPrefix],
      attrValueProcessors: [parseNumbers, parseBooleans],
      valueProcessors: [parseNumbers, parseBooleans],
    })

    const episode = data.episodes.episode as XmlEpisode[] | XmlEpisode

    let firstEpisode: XmlEpisode | null = null

    if (Array.isArray(episode)) {
      firstEpisode =
        episode.find(
          ep => ep.epno.type === EpisodeType.EPISODE && ep.epno._ === 1,
        ) || null
    } else {
      firstEpisode = episode
    }

    if (isNil(firstEpisode)) return null

    return getIdentifier(firstEpisode)
  }

  private static async getId(id: number) {
    const response = (await superagent
      .get('https://relations.yuna.moe/api/ids')
      .query({ source: 'anilist', id })
      .ok(T)) as RequestResponse<Relation, RelationError>

    if (responseIsError(response)) {
      return null
    }

    return response.body.anidb
  }
}
