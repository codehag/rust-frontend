/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef MOZILLA_GFX_DCLAYER_TREE_H
#define MOZILLA_GFX_DCLAYER_TREE_H

#include <unordered_map>
#include <windows.h>

#include "GLTypes.h"
#include "mozilla/Maybe.h"
#include "mozilla/RefPtr.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/webrender/WebRenderTypes.h"

struct ID3D11Device;
struct ID3D11DeviceContext;
struct IDCompositionDevice2;
struct IDCompositionSurface;
struct IDCompositionTarget;
struct IDCompositionVisual2;
struct IDXGISwapChain1;
struct IDCompositionVirtualSurface;

namespace mozilla {

namespace gl {
class GLContext;
}

namespace wr {

#define USE_VIRTUAL_SURFACES

// DirectComposition virtual surfaces are zero based, but WR picture cache
// bounds can potentially have a negative origin. Shift all the picture cache
// coordinates by a large fixed amount, such that we don't need to re-create
// the surface if the picture cache origin becomes negative due to adding more
// tiles to the above / left.
#define VIRTUAL_OFFSET 512 * 1024

class DCLayer;
class DCSurface;

/**
 * DCLayerTree manages direct composition layers.
 * It does not manage gecko's layers::Layer.
 */
class DCLayerTree {
 public:
  static UniquePtr<DCLayerTree> Create(gl::GLContext* aGL, EGLConfig aEGLConfig,
                                       ID3D11Device* aDevice, HWND aHwnd);
  explicit DCLayerTree(gl::GLContext* aGL, EGLConfig aEGLConfig,
                       ID3D11Device* aDevice,
                       IDCompositionDevice2* aCompositionDevice);
  ~DCLayerTree();

  void SetDefaultSwapChain(IDXGISwapChain1* aSwapChain);
  void MaybeUpdateDebug();
  void MaybeCommit();
  void WaitForCommitCompletion();
  void DisableNativeCompositor();

  // Interface for wr::Compositor
  void CompositorBeginFrame();
  void CompositorEndFrame();
  void Bind(wr::NativeTileId aId, wr::DeviceIntPoint* aOffset, uint32_t* aFboId,
            wr::DeviceIntRect aDirtyRect);
  void Unbind();
  void CreateSurface(wr::NativeSurfaceId aId, wr::DeviceIntSize aTileSize,
                     bool aIsOpaque);
  void DestroySurface(NativeSurfaceId aId);
  void CreateTile(wr::NativeSurfaceId aId, int32_t aX, int32_t aY);
  void DestroyTile(wr::NativeSurfaceId aId, int32_t aX, int32_t aY);
  void AddSurface(wr::NativeSurfaceId aId, wr::DeviceIntPoint aPosition,
                  wr::DeviceIntRect aClipRect);

  gl::GLContext* GetGLContext() const { return mGL; }
  EGLConfig GetEGLConfig() const { return mEGLConfig; }
  ID3D11Device* GetDevice() const { return mDevice; }
  IDCompositionDevice2* GetCompositionDevice() const {
    return mCompositionDevice;
  }
  DCSurface* GetSurface(wr::NativeSurfaceId aId) const;

  // Get or create an FBO with depth buffer suitable for specified dimensions
  GLuint GetOrCreateFbo(int aWidth, int aHeight);

 protected:
  bool Initialize(HWND aHwnd);
  bool MaybeUpdateDebugCounter();
  bool MaybeUpdateDebugVisualRedrawRegions();
  void DestroyEGLSurface();
  GLuint CreateEGLSurfaceForCompositionSurface(
      wr::DeviceIntRect aDirtyRect, wr::DeviceIntPoint* aOffset,
      RefPtr<IDCompositionSurface> aCompositionSurface,
      wr::DeviceIntPoint aSurfaceOffset);
  void ReleaseNativeCompositorResources();

  RefPtr<gl::GLContext> mGL;
  EGLConfig mEGLConfig;

  RefPtr<ID3D11Device> mDevice;

  RefPtr<IDCompositionDevice2> mCompositionDevice;
  RefPtr<IDCompositionTarget> mCompositionTarget;
  RefPtr<IDCompositionVisual2> mRootVisual;
  RefPtr<IDCompositionVisual2> mDefaultSwapChainVisual;

  bool mDebugCounter;
  bool mDebugVisualRedrawRegions;

  Maybe<RefPtr<IDCompositionSurface>> mCurrentSurface;

  // The EGL image that is bound to the D3D texture provided by
  // DirectComposition.
  EGLImage mEGLImage;

  // The GL render buffer ID that maps the EGLImage to an RBO for attaching to
  // an FBO.
  GLuint mColorRBO;

  struct SurfaceIdHashFn {
    std::size_t operator()(const wr::NativeSurfaceId& aId) const {
      return HashGeneric(wr::AsUint64(aId));
    }
  };

  std::unordered_map<wr::NativeSurfaceId, UniquePtr<DCSurface>, SurfaceIdHashFn>
      mDCSurfaces;

  // A list of layer IDs as they are added to the visual tree this frame.
  std::vector<wr::NativeSurfaceId> mCurrentLayers;

  // The previous frame's list of layer IDs in visual order.
  std::vector<wr::NativeSurfaceId> mPrevLayers;

  // Information about a cached FBO that is retained between frames.
  struct CachedFrameBuffer {
    int width;
    int height;
    GLuint fboId;
    GLuint depthRboId;
  };

  // A cache of FBOs, containing a depth buffer allocated to a specific size.
  // TODO(gw): Might be faster as a hashmap? The length is typically much less
  // than 10.
  std::vector<CachedFrameBuffer> mFrameBuffers;

  bool mPendingCommit;
};

/**
 Represents a single picture cache slice. Each surface contains some
 number of tiles. An implementation may choose to allocate individual
 tiles to render in to (as the current impl does), or allocate a large
 single virtual surface to draw into (e.g. the DirectComposition virtual
 surface API in future).
 */
class DCSurface {
 public:
  explicit DCSurface(wr::DeviceIntSize aTileSize, bool aIsOpaque,
                     DCLayerTree* aDCLayerTree);
  ~DCSurface();

  bool Initialize();
  void CreateTile(int32_t aX, int32_t aY);
  void DestroyTile(int32_t aX, int32_t aY);

  IDCompositionVisual2* GetVisual() const { return mVisual; }
  DCLayer* GetLayer(int32_t aX, int32_t aY) const;

  struct TileKey {
    TileKey(int32_t aX, int32_t aY) : mX(aX), mY(aY) {}

    int32_t mX;
    int32_t mY;
  };

#ifdef USE_VIRTUAL_SURFACES
  wr::DeviceIntSize GetTileSize() const { return mTileSize; }

  IDCompositionVirtualSurface* GetCompositionSurface() const {
    return mVirtualSurface;
  }

  void UpdateAllocatedRect();
#endif

 protected:
  DCLayerTree* mDCLayerTree;

  struct TileKeyHashFn {
    std::size_t operator()(const TileKey& aId) const {
      return HashGeneric(aId.mX, aId.mY);
    }
  };

  // The visual for this surface. No content is attached to here, but tiles
  // that belong to this surface are added as children. In this way, we can
  // set the clip and scroll offset once, on this visual, to affect all
  // children.
  RefPtr<IDCompositionVisual2> mVisual;

  wr::DeviceIntSize mTileSize;
  bool mIsOpaque;
  bool mAllocatedRectDirty;
  std::unordered_map<TileKey, UniquePtr<DCLayer>, TileKeyHashFn> mDCLayers;

#ifdef USE_VIRTUAL_SURFACES
  RefPtr<IDCompositionVirtualSurface> mVirtualSurface;
#endif
};

/**
 Represents a tile within a surface.
 TODO(gw): We should probably rename this to DCTile as a follow up.
 */
class DCLayer {
 public:
  explicit DCLayer(DCLayerTree* aDCLayerTree);
  ~DCLayer();
  bool Initialize(int aX, int aY, wr::DeviceIntSize aSize, bool aIsOpaque);

#ifndef USE_VIRTUAL_SURFACES
  IDCompositionSurface* GetCompositionSurface() const {
    return mCompositionSurface;
  }
  IDCompositionVisual2* GetVisual() const { return mVisual; }

 protected:
  RefPtr<IDCompositionSurface> CreateCompositionSurface(wr::DeviceIntSize aSize,
                                                        bool aIsOpaque);

  RefPtr<IDCompositionSurface> mCompositionSurface;
  RefPtr<IDCompositionVisual2> mVisual;
#endif

  DCLayerTree* mDCLayerTree;
};

static inline bool operator==(const DCSurface::TileKey& a0,
                              const DCSurface::TileKey& a1) {
  return a0.mX == a1.mX && a0.mY == a1.mY;
}

}  // namespace wr
}  // namespace mozilla

#endif
