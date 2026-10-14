import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Windows paths are case insensitive; keys and outputs must not alias by case. */
export const protectedPathIdentity = (path, platform = process.platform) => {
  const absolute = resolve(path)
  return platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** A dot-prefixed child such as '..keys' is still inside the checkout. */
export const isOutsideCheckout = (checkout, path) => {
  const location = relative(resolve(checkout), resolve(path))
  return location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)
}
