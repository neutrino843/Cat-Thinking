export const assertDedicatedPostgresTestDatabase = (value: string): void => {
  try {
    const database = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(database.protocol)
      || !['/cat_analysis_test', '/cat_analysis_smoke'].includes(database.pathname)) throw new Error('invalid')
  } catch {
    throw new Error('PostgreSQL recovery tests require a dedicated cat_analysis_test or cat_analysis_smoke database')
  }
}
