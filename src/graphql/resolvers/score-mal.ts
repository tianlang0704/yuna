import { AnimeViewAnime } from '@/graphql/types'
import { isNil } from '@/utils'
import { fetchRating } from '@/lib/myanimelist'

export const scoreMalResolver = async (
  media: AnimeViewAnime,
): Promise<number | null> => {
  if (isNil(media) || isNil(media.idMal)) return null

  try {
    return fetchRating(media.idMal)
  } catch (err) {
    return null
  }
}
