def select_jwk(header, keys, allowed_algorithms):
    return next(key for key in keys if key["kid"] == header["kid"])
