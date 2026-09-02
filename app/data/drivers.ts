/**
 * 2026 Formula 1 grid — 11 teams, 22 cars.
 * `tv` is the colour used by the timing graphics; `body`/`accent` drive the 3D livery.
 * Ratings are relative pace factors used by the simulation (1.0 = reference).
 */

export type TeamId =
  | 'mclaren' | 'ferrari' | 'redbull' | 'mercedes' | 'astonmartin' | 'alpine'
  | 'williams' | 'racingbulls' | 'haas' | 'audi' | 'cadillac'

export interface Team {
  id: TeamId
  name: string
  short: string
  tv: string
  body: string
  accent: string
  pace: number
}

export interface Driver {
  code: string
  number: number
  firstName: string
  lastName: string
  team: TeamId
  skill: number
  helmet: string
}

export const TEAMS: Record<TeamId, Team> = {
  mclaren: { id: 'mclaren', name: 'McLaren', short: 'MCL', tv: '#FF8000', body: '#FF8000', accent: '#141414', pace: 1.0 },
  ferrari: { id: 'ferrari', name: 'Ferrari', short: 'FER', tv: '#E8002D', body: '#E8002D', accent: '#1a1a1a', pace: 0.996 },
  mercedes: { id: 'mercedes', name: 'Mercedes', short: 'MER', tv: '#27F4D2', body: '#101416', accent: '#27F4D2', pace: 0.996 },
  redbull: { id: 'redbull', name: 'Red Bull Racing', short: 'RBR', tv: '#3671C6', body: '#101B4C', accent: '#E30613', pace: 0.994 },
  astonmartin: { id: 'astonmartin', name: 'Aston Martin', short: 'AMR', tv: '#229971', body: '#006F62', accent: '#C3E600', pace: 0.987 },
  williams: { id: 'williams', name: 'Williams', short: 'WIL', tv: '#64C4FF', body: '#0B2A73', accent: '#64C4FF', pace: 0.986 },
  racingbulls: { id: 'racingbulls', name: 'Racing Bulls', short: 'RB', tv: '#6692FF', body: '#F4F4F4', accent: '#1E3EA8', pace: 0.984 },
  alpine: { id: 'alpine', name: 'Alpine', short: 'ALP', tv: '#0093CC', body: '#0F3E9C', accent: '#F35BB7', pace: 0.980 },
  haas: { id: 'haas', name: 'Haas F1 Team', short: 'HAA', tv: '#B6BABD', body: '#E9E9E9', accent: '#D0021B', pace: 0.981 },
  audi: { id: 'audi', name: 'Audi', short: 'AUD', tv: '#F50537', body: '#C9CDD2', accent: '#F50537', pace: 0.979 },
  cadillac: { id: 'cadillac', name: 'Cadillac', short: 'CAD', tv: '#D4B24C', body: '#121212', accent: '#D4B24C', pace: 0.972 },
}

export const DRIVERS: Driver[] = [
  { code: 'NOR', number: 1, firstName: 'Lando', lastName: 'Norris', team: 'mclaren', skill: 1.003, helmet: '#F5E100' },
  { code: 'PIA', number: 81, firstName: 'Oscar', lastName: 'Piastri', team: 'mclaren', skill: 1.003, helmet: '#2F7CF6' },
  { code: 'LEC', number: 16, firstName: 'Charles', lastName: 'Leclerc', team: 'ferrari', skill: 1.003, helmet: '#F2F2F2' },
  { code: 'HAM', number: 44, firstName: 'Lewis', lastName: 'Hamilton', team: 'ferrari', skill: 1.001, helmet: '#7A1FA2' },
  { code: 'RUS', number: 63, firstName: 'George', lastName: 'Russell', team: 'mercedes', skill: 1.002, helmet: '#1F5BFF' },
  { code: 'ANT', number: 12, firstName: 'Andrea Kimi', lastName: 'Antonelli', team: 'mercedes', skill: 1.0, helmet: '#00C2A8' },
  { code: 'VER', number: 3, firstName: 'Max', lastName: 'Verstappen', team: 'redbull', skill: 1.005, helmet: '#FF4B00' },
  { code: 'HAD', number: 6, firstName: 'Isack', lastName: 'Hadjar', team: 'redbull', skill: 0.998, helmet: '#F0F0F0' },
  { code: 'ALO', number: 14, firstName: 'Fernando', lastName: 'Alonso', team: 'astonmartin', skill: 1.002, helmet: '#2C5FE8' },
  { code: 'STR', number: 18, firstName: 'Lance', lastName: 'Stroll', team: 'astonmartin', skill: 0.995, helmet: '#F19CBB' },
  { code: 'ALB', number: 23, firstName: 'Alexander', lastName: 'Albon', team: 'williams', skill: 1.0, helmet: '#E9E9E9' },
  { code: 'SAI', number: 55, firstName: 'Carlos', lastName: 'Sainz', team: 'williams', skill: 1.001, helmet: '#D6001C' },
  { code: 'LAW', number: 30, firstName: 'Liam', lastName: 'Lawson', team: 'racingbulls', skill: 0.998, helmet: '#111111' },
  { code: 'LIN', number: 41, firstName: 'Arvid', lastName: 'Lindblad', team: 'racingbulls', skill: 0.996, helmet: '#FFD400' },
  { code: 'GAS', number: 10, firstName: 'Pierre', lastName: 'Gasly', team: 'alpine', skill: 1.0, helmet: '#00A3E0' },
  { code: 'COL', number: 43, firstName: 'Franco', lastName: 'Colapinto', team: 'alpine', skill: 0.996, helmet: '#75AADB' },
  { code: 'OCO', number: 31, firstName: 'Esteban', lastName: 'Ocon', team: 'haas', skill: 0.999, helmet: '#FF6A00' },
  { code: 'BEA', number: 87, firstName: 'Oliver', lastName: 'Bearman', team: 'haas', skill: 0.998, helmet: '#00B2FF' },
  { code: 'HUL', number: 27, firstName: 'Nico', lastName: 'Hülkenberg', team: 'audi', skill: 0.999, helmet: '#F2F2F2' },
  { code: 'BOR', number: 5, firstName: 'Gabriel', lastName: 'Bortoleto', team: 'audi', skill: 0.997, helmet: '#009C3B' },
  { code: 'BOT', number: 77, firstName: 'Valtteri', lastName: 'Bottas', team: 'cadillac', skill: 0.999, helmet: '#FFFFFF' },
  { code: 'PER', number: 11, firstName: 'Sergio', lastName: 'Pérez', team: 'cadillac', skill: 0.998, helmet: '#C8102E' },
]

export const TEAM_ORDER: TeamId[] = Object.keys(TEAMS) as TeamId[]

export type Compound = 'S' | 'M' | 'H'

export const COMPOUND_COLORS: Record<Compound, string> = {
  S: '#E8002D',
  M: '#FFD400',
  H: '#F0F0F0',
}
