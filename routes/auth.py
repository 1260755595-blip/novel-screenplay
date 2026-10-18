"""Auth routes: setup, login, logout, password change, /me."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from core.database import get_db
from core.models import User, Session as SessionModel
from core.auth import (
    hash_password, verify_password, create_session, get_current_user, COOKIE_NAME,
)

router = APIRouter()


def user_to_dict(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "is_active": user.is_active,
        "max_monthly_runs": user.max_monthly_runs,
        "max_projects": user.max_projects,
        "max_active_jobs": user.max_active_jobs,
        "max_chapters_per_project": user.max_chapters_per_project,
        "monthly_runs": user.monthly_runs,
    }


class SetupBody(BaseModel):
    username: str
    password: str
    display_name: str = ""


class LoginBody(BaseModel):
    username: str
    password: str


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.post("/auth/setup")
def setup(body: SetupBody, response: Response, db: Session = Depends(get_db)):
    if db.query(User).count() > 0:
        raise HTTPException(status_code=400, detail="系统已初始化，请直接登录")
    if not body.username or not body.password:
        raise HTTPException(status_code=400, detail="用户名和密码不能为空")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")
    user = User(
        username=body.username,
        display_name=body.display_name or body.username,
        password_hash=hash_password(body.password),
        role="admin",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_session(db, user)
    response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax")
    return {"user": user_to_dict(user)}


@router.post("/auth/login")
def login(body: LoginBody, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已停用")
    token = create_session(db, user)
    response.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax")
    return {"user": user_to_dict(user)}


@router.post("/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db.query(SessionModel).filter(SessionModel.token == token).delete()
        db.commit()
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.patch("/auth/password")
def change_password(
    body: PasswordBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="当前密码不正确")
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="新密码至少 6 位")
    user.password_hash = hash_password(body.new_password)
    # revoke other sessions but keep current one
    current_token = request.cookies.get(COOKIE_NAME)
    query = db.query(SessionModel).filter(SessionModel.user_id == user.id)
    if current_token:
        query = query.filter(SessionModel.token != current_token)
    query.delete()
    db.commit()
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return {"user": user_to_dict(user)}
